// Smoke test Fase 1 (dev only, bukan bagian dari test suite):
// - Menjalankan CLI ASLI (npx tsx src/cli.ts) melawan server HTTP LLM palsu
//   yang menjawab seperti API OpenAI (streaming SSE).
// - Run 1: sesi baru -> .jsonl ditulis (NDJSON valid) + .json sesi tersimpan.
// - Run 2: --continue <id> di proses baru -> riwayat run 1 terbaca dari log.
// - Run 3: --yolo -> perintah confirm dijalankan tanpa bertanya.
// - Run 4: tanpa --yolo (non-interaktif) -> perintah yang sama ditolak.
// Usage: npx tsx scripts/smoke-fase1.ts
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, realpath } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentEvent } from "../src/events.js";

const seen: Array<{ messages: unknown[] }> = [];

function sseChunk(delta: unknown, finish: string | null, usage?: unknown) {
  const chunk: Record<string, unknown> = {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  if (usage) chunk.usage = usage;
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** Fake OpenAI server: scripts the reply from the last user message. */
function startFakeLlm() {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as {
        messages?: Array<{ role: string; content?: unknown }>;
      };
      const msgs = parsed.messages ?? [];
      seen.push({ messages: msgs });
      const lastUser = [...msgs]
        .reverse()
        .find((m) => m.role === "user");
      const text =
        typeof lastUser?.content === "string" ? lastUser.content : "";
      const hasToolResult = msgs.some((m) => m.role === "tool");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const usage = {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
      };
      if (hasToolResult) {
        // Second call of a run: just finish with text.
        res.end(
          sseChunk({ content: "Selesai." }, null) +
            sseChunk({}, "stop", usage) +
            "data: [DONE]\n\n",
        );
        return;
      }
      if (text.includes("coba perintah")) {
        res.end(
          sseChunk(
            {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "run_command",
                    arguments: JSON.stringify({
                      command: "rm -rf node_modules",
                    }),
                  },
                },
              ],
            },
            null,
          ) +
            sseChunk({}, "tool_calls", usage) +
            "data: [DONE]\n\n",
        );
        return;
      }
      if (text.includes("tambah judul")) {
        res.end(
          sseChunk({ content: "Judul ditambahkan." }, null) +
            sseChunk({}, "stop", usage) +
            "data: [DONE]\n\n",
        );
        return;
      }
      res.end(
        sseChunk(
          {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({
                    path: "index.html",
                    content: "<h1>Kopi</h1>",
                  }),
                },
              },
            ],
          },
          null,
        ) +
          sseChunk({}, "tool_calls", usage) +
          "data: [DONE]\n\n",
      );
    });
  });
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => server.close(),
      });
    });
  });
}

function runCli(
  repoDir: string,
  env: NodeJS.ProcessEnv,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "npx",
      ["tsx", "src/cli.ts", ...args],
      { cwd: repoDir, env, timeout: 60_000 },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (error as { code?: number }).code ?? 1 : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

function parseNdjson(stdout: string): AgentEvent[] {
  return stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => AgentEvent.parse(JSON.parse(l)));
}

async function main(): Promise<number> {
  const repoDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const base = await mkdtemp(join(tmpdir(), "bikinin-smoke1-"));
  await mkdir(join(base, "ws"));
  const workspace = await realpath(join(base, "ws"));
  const fake = await startFakeLlm();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BIKININ_WORKSPACE: workspace,
    LLM_BASE_URL: `${fake.url}/v1`,
    LLM_API_KEY: "dummy-key",
    BIKININ_MODEL: "test-model",
    PRICE_INPUT_PER_M: "1",
    PRICE_OUTPUT_PER_M: "2",
  };
  const checks: Array<[string, boolean]> = [];
  const check = (name: string, ok: boolean) => {
    console.log(`${ok ? "✓" : "✗"} ${name}`);
    checks.push([name, ok]);
  };

  // --- Run 1: sesi baru ---
  const r1 = await runCli(repoDir, env, [
    "--json",
    "namaku Rizqi, buat halaman kopi.",
  ]);
  const ev1 = parseNdjson(r1.stdout);
  const started1 = ev1.find((e) => e.type === "run_started");
  const sessionId =
    started1?.type === "run_started" ? started1.session_id : "";
  check("run 1 exit 0", r1.code === 0);
  check("run 1 punya session id", sessionId.startsWith("s_"));
  const logPath = join(
    workspace,
    ".bikinin",
    "sessions",
    `${sessionId}.jsonl`,
  );
  const rawLog = await readFile(logPath, "utf8");
  const lines = rawLog.trim().split("\n");
  const parsed = lines.map((l) => AgentEvent.safeParse(JSON.parse(l)));
  check(".jsonl valid NDJSON semua baris", parsed.every((p) => p.success));
  const firstOk =
    parsed[0]?.success === true && parsed[0].data.type === "run_started";
  const last = parsed.at(-1);
  const lastOk =
    last?.success === true && last.data.type === "run_finished";
  check(
    ".jsonl diawali run_started diakhiri run_finished",
    firstOk && lastOk,
  );
  const sessionJson = JSON.parse(
    await readFile(
      join(workspace, ".bikinin", "sessions", `${sessionId}.json`),
      "utf8",
    ),
  ) as { history: unknown[][] };
  check(".json sesi tersimpan dengan riwayat", sessionJson.history.length >= 1);
  check(
    "index.html dibuat di workspace",
    (await readFile(join(workspace, "index.html"), "utf8")).includes("Kopi"),
  );

  // --- Run 2: --continue di proses baru (restart) ---
  const before = seen.length;
  const r2 = await runCli(repoDir, env, [
    "--json",
    "--continue",
    sessionId,
    "tambah judul",
  ]);
  check("run 2 --continue exit 0", r2.code === 0);
  const seenRun2 = seen.slice(before);
  const historySeen = seenRun2.some((s) =>
    JSON.stringify(s.messages).includes(
      "namaku Rizqi, buat halaman kopi.",
    ),
  );
  check("--continue membaca riwayat run 1 dari log", historySeen);
  const ev2 = parseNdjson(r2.stdout);
  check(
    "run 2 menulis ke .jsonl yang sama",
    (await readFile(logPath, "utf8")).trim().split("\n").length >
      lines.length,
  );
  void ev2;

  // --- Run 3: --yolo menyetujui perintah confirm ---
  const r3 = await runCli(repoDir, env, ["--json", "--yolo", "coba perintah"]);
  const ev3 = parseNdjson(r3.stdout);
  const s3 = ev3.find((e) => e.type === "run_started");
  const sid3 = s3?.type === "run_started" ? s3.session_id : "";
  const log3 = await readFile(
    join(workspace, ".bikinin", "sessions", `${sid3}.jsonl`),
    "utf8",
  );
  check(
    "--yolo menyetujui perintah (approval allow)",
    log3.includes('"decision":"allow"'),
  );

  // --- Run 4: tanpa --yolo, non-interaktif -> ditolak ---
  const r4 = await runCli(repoDir, env, ["--json", "coba perintah"]);
  const ev4 = parseNdjson(r4.stdout);
  const s4 = ev4.find((e) => e.type === "run_started");
  const sid4 = s4?.type === "run_started" ? s4.session_id : "";
  const log4 = await readFile(
    join(workspace, ".bikinin", "sessions", `${sid4}.jsonl`),
    "utf8",
  );
  check(
    "tanpa --yolo perintah ditolak (approval deny)",
    log4.includes('"decision":"deny"'),
  );

  // --- Sesi lain tidak bocor ---
  const sessions = await readdir(join(workspace, ".bikinin", "sessions"));
  // run 1 + run 2 berbagi satu sesi; run 3 dan run 4 masing-masing satu sesi
  check(
    "3 sesi terpisah tercatat",
    sessions.filter((f) => f.endsWith(".json")).length === 3,
  );

  fake.close();
  const pass = checks.every(([, ok]) => ok);
  console.log(pass ? "SMOKE PASS" : "SMOKE FAIL");
  return pass ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
