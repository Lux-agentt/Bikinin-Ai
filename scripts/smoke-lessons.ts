// Smoke test for episodic lessons (dev only, not part of the test suite):
// boots the REAL http server with a scripted fake LLM, runs a session where
// the same tool fails twice, proves a lesson was extracted and saved to
// lessons.md, restarts the server on the same workspace, and proves a
// similar next request gets that lesson injected into the system prompt.
// Usage: npx tsx scripts/smoke-lessons.ts
import { mkdtemp, mkdir, readFile, realpath } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.js";
import type { ChatResult, LlmClient } from "../src/llm/client.js";
import { createAppServer } from "../src/server/http.js";
import { RunManager } from "../src/server/runs.js";

const usage = { input_tokens: 100, output_tokens: 20, cached_tokens: 0 };
const cfg: Config = {
  providers: [
    {
      name: "t",
      baseUrl: "https://x.test/v1",
      apiKey: "DUMMY",
      model: "test-model",
      inPerM: 1,
      outPerM: 2,
    },
  ],
  BIKININ_USD_IDR: 17000,
  BIKININ_MAX_STEPS: 10,
  BIKININ_MAX_COST_USD: 1,
  BIKININ_WORKSPACE: "./workspace",
  BIKININ_MAX_VIDEO_SECONDS: 30,
};

const seen: string[][] = [];
const responses: ChatResult[] = [
  // Run 1: Fase 5 plan-first — the first turn must set a plan, otherwise
  // the loop nudges and discards the other tool calls of that turn.
  {
    text: "",
    toolCalls: [
      {
        id: "t0",
        type: "function",
        function: {
          name: "update_plan",
          arguments: JSON.stringify({
            items: [{ text: "Baca file konfigurasi", status: "doing" }],
          }),
        },
      },
    ],
    usage,
  },
  // Then read the same missing file twice, then give up.
  {
    text: "",
    toolCalls: [
      {
        id: "t1",
        type: "function",
        function: {
          name: "read_file",
          arguments: JSON.stringify({ path: "config-yang-hilang.json" }),
        },
      },
    ],
    usage,
  },
  {
    text: "",
    toolCalls: [
      {
        id: "t2",
        type: "function",
        function: {
          name: "read_file",
          arguments: JSON.stringify({ path: "config-yang-hilang.json" }),
        },
      },
    ],
    usage,
  },
  { text: "File tidak ditemukan, saya berhenti.", toolCalls: [], usage },
  // Run 2: a similar request, answered directly with plain text
  // (no tool calls, so no plan nudge fires and one chat call suffices).
  { text: "OK, saya cek dulu dengan cara lain.", toolCalls: [], usage },
];
let i = 0;
const llm: LlmClient = {
  async chat(p) {
    seen.push(
      p.messages.map((m) => (typeof m.content === "string" ? m.content : "")),
    );
    const r = responses[i++];
    if (!r) throw new Error("skrip habis");
    return r;
  },
};

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function boot(manager: RunManager, workspace: string) {
  const server = createAppServer(manager, workspace);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

async function waitForFile(path: string, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      await readFile(path, "utf8");
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return false;
}

async function main(): Promise<number> {
  const base = await mkdtemp(join(tmpdir(), "bikinin-smoke-"));
  await mkdir(join(base, "ws"));
  const workspace = await realpath(join(base, "ws"));
  console.log(`workspace: ${workspace}`);

  // --- server 1: one run where read_file fails twice on the same file ---
  const m1 = new RunManager(cfg, { workspace, systemPrompt: "sys", llm });
  const s1 = await boot(m1, workspace);
  const first = (await (
    await post(`${s1.url}/api/runs`, {
      message: "baca file config-yang-hilang.json",
    })
  ).json()) as { run_id: string; session_id: string };
  await (await fetch(`${s1.url}/api/runs/${first.run_id}/events`)).text();
  const lessonsFile = join(workspace, ".bikinin", "lessons.md");
  const okLessons = await waitForFile(lessonsFile);
  console.log(`lessons file written: ${okLessons}`);
  if (okLessons) console.log(await readFile(lessonsFile, "utf8"));
  await s1.close();

  // --- server 2 (restart): same workspace, fresh manager + init() ---
  const m2 = new RunManager(cfg, { workspace, systemPrompt: "sys", llm });
  await m2.init();
  const s2 = await boot(m2, workspace);
  const second = (await (
    await post(`${s2.url}/api/runs`, {
      message: "tolong baca file konfigurasi yang hilang kemarin",
      session_id: first.session_id,
    })
  ).json()) as { run_id: string; session_id: string };
  await (await fetch(`${s2.url}/api/runs/${second.run_id}/events`)).text();
  await s2.close();

  // Run 1 used seen[0..3]; run 2's only LLM call is seen[4].
  const run2System = seen[4]?.[0] ?? "";
  const lessonsOk =
    run2System.includes("Pelajaran dari run sebelumnya") &&
    run2System.includes("read_file gagal 2×");
  console.log(`lesson injected into run 2 system prompt: ${lessonsOk}`);
  console.log(`lesson file mentions read_file: ${okLessons}`);

  const pass = okLessons && lessonsOk;
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
