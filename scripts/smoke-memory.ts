// Smoke test for persistent memory (dev only, not part of the test suite):
// boots the REAL http server with a scripted fake LLM, runs a session,
// restarts the server on the same workspace, and proves the session history
// and the long-term memory survived. Usage: npx tsx scripts/smoke-memory.ts
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
  BIKININ_MAX_COST_USD: 1,
  BIKININ_WORKSPACE: "./workspace",
  BIKININ_MAX_VIDEO_SECONDS: 30,
};

const seen: string[][] = [];
const responses: ChatResult[] = [
  {
    text: "",
    toolCalls: [
      {
        id: "t1",
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
    usage,
  },
  { text: "Selesai, halaman kopi sudah jadi.", toolCalls: [], usage },
  { text: "Namamu Rizqi, panggil aku Qi.", toolCalls: [], usage },
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

  // --- server 1: one run that teaches the agent a fact ---
  const m1 = new RunManager(cfg, { workspace, systemPrompt: "sys", llm });
  const s1 = await boot(m1, workspace);
  const first = (await (
    await post(`${s1.url}/api/runs`, {
      message: "namaku Rizqi, panggil aku Qi. Buat halaman kopi.",
    })
  ).json()) as { run_id: string; session_id: string };
  await (await fetch(`${s1.url}/api/runs/${first.run_id}/events`)).text();
  const sessionFile = join(
    workspace,
    ".bikinin",
    "sessions",
    `${first.session_id}.json`,
  );
  const memoryFile = join(workspace, ".bikinin", "memory.md");
  const okSession = await waitForFile(sessionFile);
  const okMemory = await waitForFile(memoryFile);
  console.log(`session file written: ${okSession}`);
  console.log(`memory file written: ${okMemory}`);
  if (okMemory) console.log(await readFile(memoryFile, "utf8"));
  await s1.close();

  // --- server 2 (restart): same workspace, fresh manager + init() ---
  const m2 = new RunManager(cfg, { workspace, systemPrompt: "sys", llm });
  const restored = await m2.init();
  const s2 = await boot(m2, workspace);
  const sessions = (await (
    await fetch(`${s2.url}/api/sessions`)
  ).json()) as Array<{ session_id: string; last_status: string | null }>;
  console.log(`sessions restored: ${restored}, listed: ${sessions.length}`);
  const second = (await (
    await post(`${s2.url}/api/runs`, {
      message: "siapa namaku?",
      session_id: first.session_id,
    })
  ).json()) as { run_id: string; session_id: string };
  await (await fetch(`${s2.url}/api/runs/${second.run_id}/events`)).text();
  await s2.close();

  const thirdCall = seen[2]; // run 1 used seen[0] (tool) + seen[1] (final)
  const historyOk = thirdCall?.includes(
    "namaku Rizqi, panggil aku Qi. Buat halaman kopi.",
  );
  const memoryOk =
    thirdCall?.[0]?.includes("Memori dari obrolan sebelumnya") &&
    thirdCall?.[0]?.includes("namaku Rizqi, panggil aku Qi");
  console.log(`session reused: ${second.session_id === first.session_id}`);
  console.log(`history replayed into run 3: ${historyOk}`);
  console.log(`memory injected into system prompt: ${memoryOk}`);
  console.log(`last_status after restart: ${sessions[0]?.last_status}`);

  const pass =
    okSession &&
    okMemory &&
    restored === 1 &&
    sessions.length === 1 &&
    second.session_id === first.session_id &&
    historyOk &&
    memoryOk;
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
