// Agent loop: model call -> tool calls -> results back to model, until done or a budget stops it.
// Every observable step goes through emit(); this file never prints.
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { AgentEvent, createEmitter } from "../events.js";
import { AgentError, type ErrorCode } from "../errors.js";
import type {
  ChatResult,
  LlmClient,
  ToolCallReq,
  VisionRequest,
  VisionResult,
} from "../llm/client.js";
import { echoAssistantMessage } from "../llm/client.js";
import { costUsd, type Prices } from "../llm/pricing.js";
import { Budget } from "../safety/budget.js";
import { resolveInWorkspace } from "../safety/paths.js";
import { TOOLS, toolSpecsForLlm } from "../tools/registry.js";
import { createDelegateRunner, type DelegateResult } from "./subagent.js";
import { unifiedDiff } from "./diff.js";
import {
  formatSelfCheckFeedback,
  runSelfCheck,
  SELF_CHECK_MAX_FIX_ROUNDS,
} from "./self-check.js";
import {
  truncate,
  type ParsedOk,
  type RegisteredTool,
  type ToolResult,
} from "../tools/types.js";

export type EmitFn = ReturnType<typeof createEmitter>;
type RunFinished = Extract<AgentEvent, { type: "run_finished" }>;
type Totals = RunFinished["totals"];
type RunStatus = RunFinished["status"];

export interface ApprovalRequest {
  approvalId: string;
  command: string;
  reason: string;
  risk: "low" | "medium" | "high";
}

export interface AgentDeps {
  llm: LlmClient;
  model: string;
  /** Effort chosen in the UI; recorded in run_started, no behaviour change. */
  effort?: "sedang" | "tinggi";
  systemPrompt: string;
  message: string;
  sessionId: string;
  workspace: string; // absolute realpath
  limits: { maxCostUsd: number; maxSteps?: number };
  /**
   * Auto-approve low/medium-risk approvals without asking (owner rule,
   * BIKININ_AUTO_APPROVE=1). High-risk approvals still ask; hard blocks
   * still block. Off by default.
   *
   * maxSteps is optional and only used by subagents (their own 8-step
   * cap); the main run has no step limit since 28 Nov 2026.
   */
  autoApproveLowMedium?: boolean;
  prices: Prices;
  emit: EmitFn;
  approve: (req: ApprovalRequest) => Promise<boolean>;
  signal?: AbortSignal;
  /** Earlier messages of this session (after the system prompt), replayed before the new message. */
  history?: ChatCompletionMessageParam[];
  /** Tools this run may call. Default: all of TOOLS. Subagents pass a read-only subset. */
  tools?: RegisteredTool[];
  /** True for subagent runs: skips the plan-first nudge (a subagent has
   *  one focused task, not a plan). */
  isSubagent?: boolean; /** Checkpoint made before this run (Fase 5, server only). Emitted as
   *  `checkpoint_created` right after `run_started`. */
  checkpoint?: { id: string; method: "git" | "copy"; files: number };
  /** Why the checkpoint could not be made (emitted as an `error` event instead). */
  checkpointError?: string;
  /** Vision, wired from the fallback LLM (Fase 6). Passed to tools as
   *  ToolContext.describeImage; absent when the run has no vision. */
  describeImage?: (req: VisionRequest) => Promise<VisionResult>;
}

export interface AgentResult {
  status: RunStatus;
  summary: string;
  totals: Totals;
  durationMs: number;
  filesCreated: string[];
  filesChanged: string[];
  /** This run's messages after the system prompt (user, assistant, tool). Store with SessionHistory. */
  transcript: ChatCompletionMessageParam[];
}

interface ToolOutput {
  id: string;
  content: string;
  /** True when the call failed (blocked, denied, threw, or ok:false). Used for the retry budget. */
  failed: boolean;
  /** Tool name + raw args: identical retries of the same call share a key. */
  key: string;
}

interface Job {
  call: ToolCallReq;
  callId: string;
  tool: RegisteredTool;
  parsed: ParsedOk;
  startedMs: number;
}

const PREVIEW_LIMIT = 2000;
const RETRY_BUDGET = 3; // same failing call 3x in a row -> stop and ask the user
const MAX_LOOP_CHARS = 100_000; // within-run context cap; older tool outputs collapse past it

function messageChars(m: ChatCompletionMessageParam): number {
  let n = 0;
  const c = m.content;
  if (typeof c === "string") n += c.length;
  else if (Array.isArray(c))
    for (const p of c) if (p.type === "text") n += p.text.length;
  if (m.role === "assistant" && m.tool_calls)
    for (const tc of m.tool_calls)
      if (tc.type === "function") n += tc.function.arguments.length;
  return n;
}

/** Collapse older tool outputs (keeps the newest 4 intact) once the run's
 *  context passes MAX_LOOP_CHARS. Never touches user/system messages or
 *  assistant messages with tool_calls, so the conversation stays valid. */
function compactContext(messages: ChatCompletionMessageParam[]): void {
  let total = 0;
  for (const m of messages) total += messageChars(m);
  if (total <= MAX_LOOP_CHARS) return;
  let kept = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "tool") continue;
    kept += 1;
    if (kept <= 4) continue;
    if (typeof m.content === "string" && m.content.length > 200) {
      m.content = `${m.content.slice(0, 200)}\n…[hasil tool dipotong untuk hemat konteks]`;
    }
  }
}

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return undefined;
  }
}

function errorInfo(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof AgentError)
    return { code: err.code, message: err.message };
  return {
    code: "internal",
    message: err instanceof Error ? err.message : String(err),
  };
}

export async function runAgent(d: AgentDeps): Promise<AgentResult> {
  const startedAt = Date.now();
  const budget = new Budget(d.limits.maxCostUsd, d.limits.maxSteps);
  const tokens = { input: 0, output: 0, cached: 0 };
  const created = new Set<string>();
  const changed = new Set<string>();
  const emit = d.emit;

  // Strip absolute workspace paths before anything leaves the loop.
  const sanitize = (s: string) => s.split(d.workspace).join("<workspace>");
  const oneLine = (s: string) => s.split("\n")[0].slice(0, 200);

  const totals = (): Totals => ({
    steps: budget.steps,
    input_tokens: tokens.input,
    output_tokens: tokens.output,
    cached_tokens: tokens.cached,
    cost_usd: budget.costUsd,
  });

  const flushAlerts = () => {
    for (const a of budget.takeAlerts()) {
      emit("budget_warning", {
        kind: a.kind,
        used: a.used,
        limit: a.limit,
        percent: a.percent,
      });
    }
  };

  // --- Fase 5: plan-first, retry budget, read cache, subagent. ---
  const availableTools = d.tools ?? TOOLS;
  const findTool = (name: string): RegisteredTool | undefined =>
    availableTools.find((t) => t.name === name);
  let planSet = false;
  let planNudged = false;
  let nextPlanId = 1;
  const currentPlan: Array<{
    id: string;
    text: string;
    status: "pending" | "doing" | "done";
  }> = [];
  // read_file cache: "rel:max_lines" -> mtime+size at read time + step.
  // Kuncinya MEMAKAI max_lines: read_file default cuma 400 baris, jadi
  // baca ulang file panjang dengan max_lines lebih besar adalah baca yang
  // BERBEDA (baris 401+ belum pernah terlihat) — dulu kuncinya cuma path,
  // sehingga baca ulang itu kena cache dan model tidak pernah bisa melihat
  // sisa file: ia mengulang baca yang sama berkali-kali tanpa hasil
  // (live 2026-11-28: 49 perintah, 475 dtk, Scene6.tsx dibaca ulang terus
  // untuk cari durasi di akhir file).
  const readCache = new Map<
    string,
    { mtimeMs: number; size: number; step: number }
  >();
  let lastFailKey = "";
  let failStreak = 0;
  let selfDebugUsed = false;
  // Self-debug turn (28 Nov 2026, owner rule: agent menyelesaikan masalah
  // sendiri): the first time the same call fails 3x, the run does NOT stop
  // — it gets ONE diagnosis turn first. After that, a repeat stops the run.

  // --- Fase 6: plan mode + self-check state. ---
  // Plan mode is opt-in: the model calls request_plan_approval after
  // update_plan. From that moment, file-changing tools are held until the
  // user allows the plan; on deny the run stops without changing files.
  // "not_requested" means normal mode — mutating tools run as usual.
  let planApproval: "not_requested" | "pending" | "approved" | "denied" =
    "not_requested";
  let planDenied = false;
  let selfCheckRounds = 0;

  /** True when this job would change files (or run outside code). */
  const isMutatingJob = (j: Job): boolean => {
    switch (j.tool.name) {
      case "write_file":
      case "edit_file":
      case "run_command":
      case "render_video":
      case "mcp_call":
        return true;
      case "git": {
        const op = (j.parsed.publicArgs as { op?: unknown }).op;
        return op === "commit" || op === "branch";
      }
      default:
        return false;
    }
  };

  /** File content before a write/edit, for the file_changed diff. */
  const readBefore = async (rel: string): Promise<string> => {
    try {
      const { abs } = await resolveInWorkspace(d.workspace, rel);
      return await readFile(abs, "utf8");
    } catch {
      return ""; // new file (or unreadable): diff shows all lines added
    }
  };

  const delegateRunner = createDelegateRunner({
    llm: d.llm,
    model: d.model,
    prices: d.prices,
    workspace: d.workspace,
    signal: d.signal,
    emit,
    runAgentImpl: runAgent,
    charge: (r: DelegateResult) => {
      budget.steps += r.steps;
      budget.addCost(r.costUsd);
      tokens.input += r.usage.input_tokens;
      tokens.output += r.usage.output_tokens;
      tokens.cached += r.usage.cached_tokens;
      emit("usage", {
        step: budget.steps,
        input_tokens: r.usage.input_tokens,
        output_tokens: r.usage.output_tokens,
        cached_tokens: r.usage.cached_tokens,
        cost_usd: r.costUsd,
        totals: totals(),
      });
      flushAlerts();
    },
  });

  const finish = (status: RunStatus, summary: string): AgentResult => {
    const durationMs = Date.now() - startedAt;
    const t = totals();
    emit("run_finished", {
      status,
      summary,
      totals: t,
      duration_ms: durationMs,
      resumable:
        status === "budget_exceeded" ||
        status === "stopped" ||
        status === "error",
    });
    return {
      status,
      summary,
      totals: t,
      durationMs,
      filesCreated: [...created],
      filesChanged: [...changed],
      transcript: messages.slice(1 + priorCount),
    };
  };

  const emitFinished = (
    callId: string,
    ok: boolean,
    summary: string,
    output: string,
    startedMs: number,
  ) => {
    emit("tool_call_finished", {
      call_id: callId,
      ok,
      summary: oneLine(summary),
      output_preview: sanitize(output).slice(0, PREVIEW_LIMIT),
      truncated: output.length > PREVIEW_LIMIT,
      duration_ms: Date.now() - startedMs,
    });
  };

  const runJob = async (job: Job): Promise<ToolOutput> => {
    const { call, callId, tool, parsed, startedMs } = job;
    const verdict = parsed.gate;
    const key = `${tool.name}:${call.function.arguments}`;
    const argPath = (parsed.publicArgs as { path?: unknown }).path;

    // Fase 6, plan mode: request_plan_approval asks the user through the
    // existing approval dialog. Until the plan is approved, every
    // file-changing tool is held; on deny the run stops (see runToolCalls).
    if (tool.name === "request_plan_approval") {
      const plan = parsed.publicArgs as {
        summary?: unknown;
        files?: unknown;
      };
      const summary =
        typeof plan.summary === "string" ? plan.summary : "rencana kerja";
      const files = Array.isArray(plan.files)
        ? (plan.files.filter((f) => typeof f === "string") as string[])
        : [];
      planApproval = "pending";
      const approvalId = randomUUID().slice(0, 8);
      // Auto-approve (28 Nov 2026, owner rule): low/medium-risk approvals
      // run without asking; only high-risk still pops the sheet. Plan
      // approval is medium risk, so it auto-approves when the flag is on.
      let approved: boolean;
      if (d.autoApproveLowMedium === true) {
        approved = true;
      } else {
        emit("approval_requested", {
          approval_id: approvalId,
          call_id: callId,
          tool: tool.name,
          reason: `Setujui rencana ini sebelum file diubah? ${summary}${files.length > 0 ? ` File: ${files.join(", ")}` : ""}`,
          risk: "medium",
        });
        approved = await d.approve({
          approvalId,
          command: "",
          reason: summary,
          risk: "medium",
        });
        emit("approval_resolved", {
          approval_id: approvalId,
          decision: approved ? "allow" : "deny",
          by: "user",
        });
      }
      planApproval = approved ? "approved" : "denied";
      if (!approved) planDenied = true;
      emitFinished(
        callId,
        approved,
        approved ? "rencana disetujui" : "rencana ditolak pengguna",
        approved ? summary : "",
        startedMs,
      );
      return {
        id: call.id,
        content: approved
          ? `OK: rencana disetujui — lanjut kerjakan sesuai rencana.`
          : `ERROR: pengguna menolak rencana. Berhenti tanpa mengubah file.`,
        failed: !approved,
        key,
      };
    }

    if (
      (planApproval === "pending" || planApproval === "denied") &&
      isMutatingJob(job)
    ) {
      const why =
        planApproval === "denied"
          ? "rencana ditolak pengguna"
          : "rencana belum disetujui";
      emitFinished(callId, false, `ditahan: ${why}`, "", startedMs);
      return {
        id: call.id,
        content: `ERROR: ${why} — tool pengubah file ditahan sampai rencana disetujui lewat request_plan_approval.`,
        failed: true,
        key,
      };
    }

    if (verdict.decision === "block") {
      emit("error", {
        code: "command_blocked",
        message: verdict.reason,
        retryable: true,
        call_id: callId,
      });
      emitFinished(callId, false, `diblokir: ${verdict.reason}`, "", startedMs);
      return {
        id: call.id,
        content: `ERROR: diblokir kebijakan keamanan: ${verdict.reason}`,
        failed: true,
        key,
      };
    }

    if (verdict.decision === "confirm") {
      const approvalId = randomUUID().slice(0, 8);
      // Auto-approve (28 Nov 2026, owner rule): low/medium-risk approvals
      // run without asking; only high-risk still pops the sheet.
      const autoApproved =
        d.autoApproveLowMedium === true && verdict.risk !== "high";
      let approved: boolean;
      if (autoApproved) {
        approved = true;
      } else {
        emit("approval_requested", {
          approval_id: approvalId,
          call_id: callId,
          tool: tool.name,
          command: verdict.command,
          reason: verdict.reason,
          risk: verdict.risk,
        });
        approved = await d.approve({
          approvalId,
          command: verdict.command,
          reason: verdict.reason,
          risk: verdict.risk,
        });
        emit("approval_resolved", {
          approval_id: approvalId,
          decision: approved ? "allow" : "deny",
          by: "user",
        });
      }
      if (!approved) {
        emitFinished(callId, false, "ditolak pengguna", "", startedMs);
        return {
          id: call.id,
          content:
            "ERROR: pengguna menolak perintah ini. Cari cara lain atau tanyakan pengguna.",
          failed: true,
          key,
        };
      }
    }

    // Fase 5: jangan baca ulang file yang tidak berubah di run yang sama.
    // Isinya sudah ada di riwayat percakapan, jadi kembalikan catatan singkat
    // (hemat token) alih-alih isi file yang sama untuk kedua kalinya.
    // Kunci cache memakai max_lines: baca dengan jendela lebih besar bukan
    // baca yang sama (lihat komentar di deklarasi readCache).
    if (tool.name === "read_file" && typeof argPath === "string") {
      try {
        const { abs, rel } = await resolveInWorkspace(d.workspace, argPath);
        const st = await stat(abs);
        const ml = (parsed.publicArgs as { max_lines?: unknown }).max_lines;
        const maxLines =
          typeof ml === "number" && Number.isFinite(ml)
            ? Math.floor(ml)
            : 400;
        const cacheKey = `${rel}:${maxLines}`;
        const hit = readCache.get(cacheKey);
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
          emitFinished(
            callId,
            true,
            `dari cache (tidak berubah sejak langkah ${hit.step})`,
            "",
            startedMs,
          );
          return {
            id: call.id,
            content: `OK (cache): ${rel} tidak berubah sejak dibaca di langkah ${hit.step} — isinya sudah ada di riwayat percakapan di atas, pakai itu. Kalau butuh baris di luar yang sudah dibaca (read_file maks 400 baris), baca lagi dengan max_lines lebih besar (maks 2000) atau grep bagiannya — jangan baca ulang dengan parameter yang sama.`,
            failed: false,
            key,
          };
        }
      } catch {
        // stat/resolve gagal (mis. file dihapus): biarkan eksekusi normal
        // yang menangani errornya dengan pesan yang jelas.
      }
    }

    // Fase 6: capture the old content before a write/edit, so the
    // file_changed event can carry a unified diff.
    const beforeContent =
      (tool.name === "write_file" || tool.name === "edit_file") &&
      typeof argPath === "string"
        ? await readBefore(argPath)
        : null;

    try {
      const res: ToolResult = await parsed.execute({
        workspace: d.workspace,
        delegate: delegateRunner,
        describeImage: d.describeImage,
        signal: d.signal,
      });
      for (const c of res.changes) {
        // Fase 6: diff review — fill the optional diff field for files the
        // run created or modified (deleted files have no new content).
        let diff: string | undefined;
        if (
          beforeContent !== null &&
          (c.op === "created" || c.op === "modified")
        ) {
          try {
            const { abs } = await resolveInWorkspace(d.workspace, c.path);
            const after = await readFile(abs, "utf8");
            diff = unifiedDiff(beforeContent, after, c.path) || undefined;
          } catch {
            diff = undefined; // binary/unreadable: event still carries path+bytes
          }
        }
        emit("file_changed", {
          path: c.path,
          op: c.op,
          bytes: c.bytes,
          ...(diff ? { diff } : {}),
        });
        (c.op === "created" ? created : changed).add(c.path);
      }
      // Fase 6: vision usage (inspect_image) joins the run totals and gets
      // its own usage event, priced at the run's model prices. When the
      // provider reports no usage, nothing is charged.
      if (res.usage) {
        const vCost = costUsd(res.usage, d.prices);
        tokens.input += res.usage.input_tokens;
        tokens.output += res.usage.output_tokens;
        tokens.cached += res.usage.cached_tokens;
        budget.addCost(vCost);
        emit("usage", {
          step: budget.steps,
          input_tokens: res.usage.input_tokens,
          output_tokens: res.usage.output_tokens,
          cached_tokens: res.usage.cached_tokens,
          cost_usd: vCost,
          totals: totals(),
        });
        flushAlerts();
      }
      const output = sanitize(res.output);
      // Fase 5: perbarui read cache dari hasil eksekusi.
      if (typeof argPath === "string") {
        if (tool.name === "read_file" && res.ok) {
          try {
            const { abs, rel } = await resolveInWorkspace(d.workspace, argPath);
            const st = await stat(abs);
            const ml = (parsed.publicArgs as { max_lines?: unknown })
              .max_lines;
            const maxLines =
              typeof ml === "number" && Number.isFinite(ml)
                ? Math.floor(ml)
                : 400;
            readCache.set(`${rel}:${maxLines}`, {
              mtimeMs: st.mtimeMs,
              size: st.size,
              step: budget.steps,
            });
          } catch {
            // abaikan: cache hanya optimasi
          }
        } else if (tool.name === "write_file" || tool.name === "edit_file") {
          try {
            const { rel } = await resolveInWorkspace(d.workspace, argPath);
            // Hapus SEMUA jendela baca file itu (kunci "rel:max_lines").
            for (const k of [...readCache.keys()])
              if (k.startsWith(`${rel}:`)) readCache.delete(k);
          } catch {
            // abaikan
          }
        }
      }
      if (tool.name === "run_command" && res.ok) readCache.clear();
      // Fase 5: update_plan yang berhasil -> event plan_updated untuk panel Todo.
      if (tool.name === "update_plan" && res.ok) {
        const items =
          (
            parsed.publicArgs as {
              items?: Array<{
                text: string;
                status: "pending" | "doing" | "done";
              }>;
            }
          ).items ?? [];
        for (const item of items) {
          const norm = item.text.trim().toLowerCase();
          const existing = currentPlan.find(
            (p) => p.text.trim().toLowerCase() === norm,
          );
          if (existing) existing.status = item.status;
          else
            currentPlan.push({
              id: `p${nextPlanId++}`,
              text: item.text.trim(),
              status: item.status,
            });
        }
        planSet = true;
        emit("plan_updated", { items: [...currentPlan] });
      }
      emitFinished(callId, res.ok, res.summary, output, startedMs);
      return {
        id: call.id,
        content: `${res.ok ? "OK" : "GAGAL"}: ${res.summary}\n${truncate(output).text}`,
        failed: !res.ok,
        key,
      };
    } catch (err) {
      const { code, message: raw } = errorInfo(err);
      const message = sanitize(raw);
      if (code === "path_blocked" || code === "command_blocked") {
        emit("error", { code, message, retryable: true, call_id: callId });
      }
      emitFinished(callId, false, message, "", startedMs);
      return { id: call.id, content: `ERROR: ${message}`, failed: true, key };
    }
  };

  const runToolCalls = async (
    calls: ToolCallReq[],
  ): Promise<{ outputs: ToolOutput[]; stopReason: string | null }> => {
    const results = new Map<string, ToolOutput>();
    const jobs: Job[] = [];

    for (const call of calls) {
      // Stop ditekan selagi batch tool disusun: jangan antrekan panggilan
      // yang belum jalan (run berhenti di pemeriksaan sinyal setelah batch).
      if (d.signal?.aborted) {
        results.set(call.id, {
          id: call.id,
          content: "Dihentikan pengguna.",
          failed: true,
          key: `${call.function.name}:${call.function.arguments}`,
        });
        continue;
      }
      const tool = findTool(call.function.name);
      if (!tool) {
        emit("error", {
          code: "invalid_tool_args",
          message: `tool tidak dikenal: ${call.function.name}`,
          retryable: true,
        });
        results.set(call.id, {
          id: call.id,
          content: `ERROR: tool "${call.function.name}" tidak tersedia. Pilih dari: ${availableTools.map((t) => t.name).join(", ")}`,
          failed: true,
          key: `${call.function.name}:${call.function.arguments}`,
        });
        continue;
      }

      budget.steps += 1;
      const callId = randomUUID().slice(0, 8);
      const startedMs = Date.now();
      const parsed = tool.parse(parseArgs(call.function.arguments));

      if (!parsed.ok) {
        emit("tool_call_started", {
          call_id: callId,
          step: budget.steps,
          tool: tool.name,
          label: tool.name,
          args: {},
        });
        emit("error", {
          code: "invalid_tool_args",
          message: parsed.error,
          retryable: true,
          call_id: callId,
        });
        emitFinished(
          callId,
          false,
          "argumen tidak valid",
          parsed.error,
          startedMs,
        );
        results.set(call.id, {
          id: call.id,
          content: `ERROR: argumen tidak valid: ${parsed.error}`,
          failed: true,
          key: `${tool.name}:${call.function.arguments}`,
        });
        continue;
      }

      emit("tool_call_started", {
        call_id: callId,
        step: budget.steps,
        tool: tool.name,
        label: parsed.label,
        args: parsed.publicArgs,
      });
      jobs.push({ call, callId, tool, parsed, startedMs });
    }

    // Fase 6, plan mode: a request_plan_approval in this batch is decided
    // FIRST, whatever its position in the model's call list — a write_file
    // sent in the same turn must not run before the plan is approved.
    // (tool_call_started events above keep the model's original order.)
    const planFirst = jobs.filter(
      (j) => j.tool.name === "request_plan_approval",
    );
    const rest = jobs.filter((j) => j.tool.name !== "request_plan_approval");
    const orderedJobs = [...planFirst, ...rest];

    // Batch campuran: tool baca yang BERURUTAN jalan paralel (Promise.all),
    // tool pengubah file tetap satu-per-satu sesuai urutan — jadi baca
    // sesudah tulis selalu melihat hasil tulisnya. Dulu: satu tool tulis
    // dalam batch membuat SEMUA tool (termasuk baca) jalan berurutan,
    // sehingga kerjaan terasa satu-per-satu dan lambat (aturan user
    // 2026-11-28: kerjaan harus paralel supaya tidak lemot).
    const stopped = (job: Job): ToolOutput => ({
      id: job.call.id,
      content: "Dihentikan pengguna.",
      failed: true,
      key: `${job.tool.name}:${job.call.function.arguments}`,
    });
    let readGroup: Job[] = [];
    const flushReads = async () => {
      if (readGroup.length === 0) return;
      const group = readGroup;
      readGroup = [];
      if (d.signal?.aborted) {
        for (const job of group) results.set(job.call.id, stopped(job));
        return;
      }
      const outs = await Promise.all(group.map(runJob));
      for (const o of outs) results.set(o.id, o);
    };
    for (const job of orderedJobs) {
      if (job.tool.readOnly) {
        readGroup.push(job);
        continue;
      }
      await flushReads();
      // Stop ditekan selagi satu tool jalan: jangan mulai tool
      // berikutnya dalam batch ini.
      if (d.signal?.aborted) {
        results.set(job.call.id, stopped(job));
        continue;
      }
      results.set(job.call.id, await runJob(job));
    }
    await flushReads();

    const outputs = calls.map(
      (c) =>
        results.get(c.id) ?? {
          id: c.id,
          content: "ERROR: internal",
          failed: true,
          key: `${c.function.name}:${c.function.arguments}`,
        },
    );

    // Fase 5: retry budget — panggilan yang sama gagal 3x berturut-turut
    // dengan cara yang sama berarti agent muter. Satu giliran diagnosis
    // dulu (lihat blok stopReason di bawah); kalau masih gagal, berhenti
    // dan tanya pengguna.
    let stopReason: string | null = null;
    for (const o of outputs) {
      if (o.failed) {
        if (o.key === lastFailKey) failStreak += 1;
        else {
          lastFailKey = o.key;
          failStreak = 1;
        }
        if (failStreak >= RETRY_BUDGET) {
          const firstLine = o.content.split("\n")[0].slice(0, 200);
          stopReason =
            `Berhenti: panggilan yang sama gagal ${RETRY_BUDGET}x berturut-turut ` +
            `(${o.key.split(":")[0]}). ${firstLine} ` +
            "Tanyakan pengguna sebelum mencoba lagi — jangan ulangi cara yang sama.";
          break;
        }
      } else {
        lastFailKey = "";
        failStreak = 0;
      }
    }
    return { outputs, stopReason };
  };

  emit("run_started", {
    session_id: d.sessionId,
    model: d.model,
    effort: d.effort ?? "sedang",
    user_message: d.message,
    limits: { max_cost_usd: d.limits.maxCostUsd },
  });

  // Fase 5: checkpoint event comes right after run_started, never before it.
  if (d.checkpoint) {
    emit("checkpoint_created", {
      checkpoint_id: d.checkpoint.id,
      method: d.checkpoint.method,
      files: d.checkpoint.files,
    });
  } else if (d.checkpointError) {
    emit("error", {
      code: "internal",
      message: `Checkpoint gagal dibuat: ${d.checkpointError}`,
      retryable: false,
    });
  }

  const prior = d.history ?? [];
  const priorCount = prior.length;
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: d.systemPrompt },
    ...prior,
    { role: "user", content: d.message },
  ];
  const tools = toolSpecsForLlm(availableTools);

  try {
    for (;;) {
      if (d.signal?.aborted) return finish("stopped", "Dihentikan pengguna.");
      // Step cap only applies when a maxSteps was passed (subagents);
      // the main run has no step limit since 28 Nov 2026.
      if (budget.stepsExceeded()) {
        flushAlerts();
        return finish(
          "budget_exceeded",
          `Batas ${budget.maxSteps} langkah tercapai.`,
        );
      }

      let res: ChatResult;
      try {
        res = await d.llm.chat({
          model: d.model,
          messages,
          tools,
          signal: d.signal,
          onText: (text) => emit("text_delta", { text }),
        });
      } catch (err) {
        if (d.signal?.aborted) return finish("stopped", "Dihentikan pengguna.");
        const info = errorInfo(err);
        emit("error", {
          code: info.code,
          message: info.message,
          retryable: false,
        });
        return finish("error", info.message);
      }

      tokens.input += res.usage.input_tokens;
      tokens.output += res.usage.output_tokens;
      tokens.cached += res.usage.cached_tokens;
      const cost = res.costUsd ?? costUsd(res.usage, d.prices);
      budget.addCost(cost);
      emit("usage", {
        step: budget.steps,
        input_tokens: res.usage.input_tokens,
        output_tokens: res.usage.output_tokens,
        cached_tokens: res.usage.cached_tokens,
        cost_usd: cost,
        totals: totals(),
      });
      flushAlerts();

      if (res.toolCalls.length === 0) {
        // Keep the final answer in the transcript so the next run remembers it.
        if (res.text.trim())
          messages.push({ role: "assistant", content: res.text });
        // Fase 6: self-check — verify the result as code before declaring
        // the run finished. Skipped for subagents (read-only research).
        // A failure sends the findings back to the model for at most
        // SELF_CHECK_MAX_FIX_ROUNDS fix rounds; a run out of budget ends
        // budget_exceeded instead of looping forever.
        if (!d.isSubagent && selfCheckRounds <= SELF_CHECK_MAX_FIX_ROUNDS) {
          const verification = await runSelfCheck({
            workspace: d.workspace,
            files: [...created, ...changed],
            finalText: res.text,
          });
          emit("verification", {
            outcome: verification.outcome,
            checks: verification.checks,
            fixes: selfCheckRounds,
          });
          if (verification.outcome === "fail") {
            if (selfCheckRounds >= SELF_CHECK_MAX_FIX_ROUNDS) {
              const failed = verification.checks
                .filter((c) => !c.ok)
                .map((c) => `${c.name}: ${c.detail}`)
                .join("; ");
              return finish(
                "completed",
                `${res.text.trim() || "Selesai."}\n\nCatatan: verifikasi sendiri masih menemukan masalah setelah ${SELF_CHECK_MAX_FIX_ROUNDS} putaran perbaikan — ${failed}`,
              );
            }
            if (budget.costExceeded()) {
              flushAlerts();
              return finish(
                "budget_exceeded",
                "Batas tercapai saat verifikasi menemukan masalah yang belum diperbaiki.",
              );
            }
            selfCheckRounds += 1;
            messages.push({
              role: "user",
              content: formatSelfCheckFeedback(verification, selfCheckRounds),
            });
            continue;
          }
        }
        return finish("completed", res.text.trim() || "Selesai.");
      }
      if (budget.costExceeded()) {
        return finish(
          "budget_exceeded",
          `Batas biaya $${budget.maxCostUsd} tercapai.`,
        );
      }
      if (
        budget.maxSteps !== undefined &&
        budget.steps + res.toolCalls.length > budget.maxSteps
      ) {
        return finish(
          "budget_exceeded",
          `Batas ${budget.maxSteps} langkah tercapai.`,
        );
      }

      // Fase 5: plan-first — sebelum tool pertama, model harus menulis
      // rencana singkat via update_plan. Diingatkan sekali; kalau tetap
      // tidak membuat rencana, lanjutkan saja (jangan muter tanpa henti).
      const hasPlanCall = res.toolCalls.some(
        (c) => c.function.name === "update_plan",
      );
      if (!planSet && !planNudged && !hasPlanCall && !d.isSubagent) {
        planNudged = true;
        messages.push({
          role: "system",
          content:
            "Sebelum tool lain: panggil update_plan dengan rencana singkat (maks 5 langkah) untuk tugas ini, lalu kerjakan mengikuti rencana itu. Jangan jalankan tool lain sebelum rencana dibuat.",
        });
        continue;
      }

      // echoAssistantMessage re-attaches any provider-opaque fields
      // (Gemini thought signatures, per tool call and per text turn) the
      // model issued with this response; empty-string content, not null,
      // because some OpenAI-compatible endpoints reject null content.
      messages.push(echoAssistantMessage(res));
      const { outputs, stopReason } = await runToolCalls(res.toolCalls);
      const callNames = new Map(
        res.toolCalls.map((call) => [call.id, call.function.name]),
      );
      for (const o of outputs) {
        const name = callNames.get(o.id);
        messages.push({
          role: "tool",
          tool_call_id: o.id,
          ...(name ? { name } : {}),
          content: o.content,
        });
      }
      // Fase 5: compaction ekstraktif di dalam run (tanpa model baru).
      compactContext(messages);
      flushAlerts();
      // Fase 6, plan mode: the user denied the plan — stop without
      // changing files (mutating tools in this batch were already held).
      if (planDenied) {
        return finish(
          "stopped",
          "Rencana ditolak pengguna — run berhenti tanpa mengubah file.",
        );
      }
      if (stopReason) {
        // Self-debug turn (28 Nov 2026): jangan langsung berhenti di 3x
        // pertama — beri agent satu giliran untuk mendiagnosis sendiri
        // (pola + hipotesis + SATU pemeriksaan yang membedakan), sesuai
        // pola agent-introspection-debugging: capture → diagnosis →
        // contained recovery. Subagent dikecualikan (langkahnya terbatas,
        // hanya riset baca). Kalau panggilan yang sama gagal 3x lagi,
        // run berhenti seperti biasa.
        if (!selfDebugUsed && !d.isSubagent) {
          selfDebugUsed = true;
          lastFailKey = "";
          failStreak = 0;
          messages.push({
            role: "system",
            content:
              "Panggilan yang sama gagal 3x berturut-turut — berhenti mengulang cara yang sama. " +
              "Sebelum tool lain: nyatakan (1) pola kegagalannya, (2) hipotesis penyebabnya, " +
              "(3) SATU pemeriksaan yang membedakan hipotesis itu (baca file, cek kondisi, atau satu perintah diagnostik) — lalu jalankan pemeriksaan itu, bukan mengulang panggilan yang gagal. " +
              "Kalau pemeriksaan membuktikan hipotesis salah, ubah rencana; kalau panggilan yang sama gagal lagi, run berhenti dan tanyakan pengguna.",
          });
          continue;
        }
        emit("error", {
          code: "tool_failed",
          message: stopReason,
          retryable: false,
        });
        return finish("error", stopReason);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit("error", { code: "internal", message, retryable: false });
    return finish("error", message);
  }
}
