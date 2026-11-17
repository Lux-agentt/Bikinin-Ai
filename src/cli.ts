// Terminal entry point. Text mode renders events; --json prints NDJSON (one event per line).
// Flags (Fase 1):
//   --continue [s_xxxxxxxx]  lanjutkan sesi lama (tanpa id = sesi terbaru), riwayat dibaca dari log .jsonl
//   --yolo                   setujui semua perintah di luar allowlist tanpa bertanya (hanya bila flag ini dipakai;
//                            perintah yang diblokir kebijakan tetap diblokir)
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { assertWorkspaceIsolated } from "./safety/paths.js";
import { createInterface } from "node:readline/promises";
import { runAgent } from "./agent/loop.js";
import { loadConfig } from "./config.js";
import { createEmitter, toNDJSON, type AgentEvent } from "./events.js";
import { createFallbackLlm } from "./llm/fallback.js";
import { loadSystemPrompt } from "./prompt.js";
import { formatSkillList, listSkills, REPO_SKILLS_DIR } from "./skills/loader.js";
import { parseCliArgs } from "./cli-args.js";
import { makeApprover } from "./approve.js";
import { SessionHistory, MAX_SESSIONS } from "./agent/history.js";
import { rebuildHistory } from "./agent/replay.js";
import { extractiveSummary } from "./agent/summarize.js";
import { createEventLog, readSessionEvents } from "./server/event-log.js";
import {
  loadSessions,
  pruneSessions,
  saveSession,
  SESSION_ID_RE,
} from "./server/persistence.js";

function render(e: AgentEvent, usdIdr: number): void {
  const out = (s: string) => process.stdout.write(s);
  switch (e.type) {
    case "text_delta":
      out(e.text);
      break;
    case "tool_call_started":
      out(`\n▸ ${e.label}\n`);
      break;
    case "tool_call_finished":
      out(`  ${e.ok ? "✓" : "✗"} ${e.summary}\n`);
      break;
    case "budget_warning":
      out(`\n⚠ batas ${e.kind} ${e.percent}% (${e.used}/${e.limit})\n`);
      break;
    case "error":
      out(`\n✗ [${e.code}] ${e.message}\n`);
      break;
    case "run_finished": {
      const t = e.totals;
      const rupiah = Math.round(t.cost_usd * usdIdr).toLocaleString("id-ID");
      out(
        `\n\n— ${e.status} · ${t.steps} langkah · token in ${t.input_tokens} / out ${t.output_tokens} · $${t.cost_usd.toFixed(4)} (≈Rp ${rupiah}) · ${(e.duration_ms / 1000).toFixed(1)} dtk\n`,
      );
      break;
    }
    default:
      break;
  }
}

const USAGE =
  'Pemakaian: npm run cli -- "buatkan landing page kedai kopi" [--json] [--yolo]\n' +
  '         npm run cli -- --continue [s_xxxxxxxx] "lanjutkan" [--json] [--yolo]\n';

async function main(): Promise<number> {
  let args: ReturnType<typeof parseCliArgs>;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? err.message : err}\n${USAGE}`,
    );
    return 2;
  }
  if (!args.message) {
    process.stderr.write(USAGE);
    return 2;
  }

  const cfg = loadConfig();
  await mkdir(cfg.BIKININ_WORKSPACE, { recursive: true });
  const workspace = await realpath(cfg.BIKININ_WORKSPACE);
  await assertWorkspaceIsolated(workspace);

  // --- Resolve the session: new, or --continue an old one. ---
  const runId = `run_${randomUUID().slice(0, 8)}`;
  let sessionId: string;
  let history = new SessionHistory();
  let title = args.message;
  let prompts = 0;
  let runs = 0;
  if (args.continueMode) {
    const persisted = await loadSessions(workspace);
    const target = args.continueSessionId
      ? persisted.find((s) => s.session_id === args.continueSessionId)
      : persisted[0]; // loadSessions returns newest first
    const targetId = args.continueSessionId ?? target?.session_id;
    if (!targetId || !SESSION_ID_RE.test(targetId)) {
      process.stderr.write(
        "Tidak ada sesi sebelumnya untuk dilanjutkan.\n",
      );
      return 2;
    }
    const events = await readSessionEvents(workspace, targetId);
    if (events.length > 0) {
      // Spec: --continue reads the .jsonl log.
      history = rebuildHistory(events);
    } else if (target) {
      // Sessions from before Fase 1 have no .jsonl: fall back to the
      // persisted compacted history.
      history = SessionHistory.fromJSON(target.history);
    } else {
      process.stderr.write(`Sesi tidak ditemukan: ${targetId}\n`);
      return 2;
    }
    sessionId = targetId;
    if (target) {
      title = target.title;
      prompts = target.prompts;
      runs = target.runs;
    }
    if (!args.json)
      process.stdout.write(
        `Melanjutkan sesi ${sessionId} (${history.runCount} run lama).\n`,
      );
  } else {
    sessionId = `s_${randomUUID().slice(0, 8)}`;
  }

  // Old runs are summarized (not dropped) when the history nears the budget.
  history.summarizeOldest(extractiveSummary);

  const log = createEventLog(workspace, sessionId);
  const rl = args.json
    ? null
    : createInterface({ input: process.stdin, output: process.stdout });
  const emit = createEmitter(runId, (e) => {
    log.append(e);
    if (args.json) process.stdout.write(toNDJSON(e));
    else render(e, cfg.BIKININ_USD_IDR);
  });
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());

  if (args.yolo) {
    process.stderr.write(
      "⚠ Mode --yolo aktif: perintah di luar allowlist dijalankan tanpa konfirmasi. Perintah yang diblokir kebijakan tetap diblokir.\n",
    );
  }

  const primary = cfg.providers[0];
  try {
    const result = await runAgent({
      llm: createFallbackLlm(cfg.providers),
      model: primary.model,
      systemPrompt: await loadSystemPrompt(
        formatSkillList(await listSkills(REPO_SKILLS_DIR)),
      ),
      message: args.message,
      sessionId,
      workspace,
      limits: {
        maxSteps: cfg.BIKININ_MAX_STEPS,
        maxCostUsd: cfg.BIKININ_MAX_COST_USD,
      },
      prices: { inPerM: primary.inPerM, outPerM: primary.outPerM },
      emit,
      approve: makeApprover(args.yolo, async (req) => {
        if (!rl) return false; // non-interactive: never approve
        const answer = await rl.question(
          `\n⚠ ${req.reason} [risiko ${req.risk}]\n  $ ${req.command}\n  Izinkan? [y/N] `,
        );
        return /^y(es)?$/i.test(answer.trim());
      }),
      signal: controller.signal,
      history: history.messages(),
    });
    // Durability: the run joins the session history on disk, so a later
    // --continue (or a server restart) picks it up.
    history.add(result.transcript);
    await saveSession(workspace, {
      version: 1,
      session_id: sessionId,
      title,
      prompts: prompts + 1,
      runs: runs + 1,
      last_status: result.status,
      updated_at: Date.now(),
      history: history.toJSON(),
    });
    await pruneSessions(workspace, MAX_SESSIONS).catch(() => {});
    if (!args.json) process.stdout.write(`\nHasil di: ${workspace}\n`);
    return result.status === "completed" ? 0 : 1;
  } finally {
    rl?.close();
    await log.flush();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
