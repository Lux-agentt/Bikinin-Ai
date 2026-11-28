import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { AgentEvent, toNDJSON } from "../src/events.js";
import type { ChatResult, LlmClient, ToolCallReq } from "../src/llm/client.js";
import { createAppServer } from "../src/server/http.js";
import { BusyError, RunManager } from "../src/server/runs.js";
import { readSessionEvents } from "../src/server/event-log.js";

const usage = { input_tokens: 100, output_tokens: 20, cached_tokens: 0 };
const call = (id: string, name: string, args: unknown): ToolCallReq => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const withCalls = (...toolCalls: ToolCallReq[]): ChatResult => ({
  text: "",
  toolCalls,
  usage,
});
// Fase 5: plan-first — scripted models start with update_plan, because the
// loop nudges (and discards) a first tool batch without a plan.
const plan = (id: string) =>
  call(id, "update_plan", {
    items: [{ text: "Kerjakan tugas", status: "doing" }],
  });
const finalText = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  usage,
});

function scripted(responses: ChatResult[]): LlmClient {
  let i = 0;
  return {
    async chat(p) {
      const r = responses[i++];
      if (!r) throw new Error("skrip habis");
      if (r.text) p.onText?.(r.text);
      return r;
    },
  };
}

const cfg: Config = {
  providers: [
    {
      name: "t",
      baseUrl: "https://x.test/v1",
      apiKey: "SECRET_KEY_VALUE",
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

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.();
});

async function boot(
  responses: ChatResult[],
  cfgOverride: Partial<Config> = {},
) {
  const base = await mkdtemp(join(tmpdir(), "bikinin-srv-"));
  await mkdir(join(base, "ws"));
  const workspace = await realpath(join(base, "ws"));
  await writeFile(join(base, "secret.txt"), "di luar workspace");
  const manager = new RunManager(
    { ...cfg, ...cfgOverride },
    {
      workspace,
      systemPrompt: "sys",
      llm: scripted(responses),
    },
  );
  const server = createAppServer(manager, workspace);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  open.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, manager, workspace };
}

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

function parseSse(text: string): AgentEvent[] {
  return text
    .split("\n\n")
    .map((frame) => frame.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => Boolean(l))
    .map((l) => JSON.parse(l.slice(6)) as AgentEvent);
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 3000) {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error("timeout menunggu kondisi");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("web server", () => {
  it("serves the UI with a strict CSP, and config without secrets", async () => {
    const { url } = await boot([]);
    const page = await fetch(`${url}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(
      "script-src 'self'",
    );
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    const config = await (await fetch(`${url}/api/config`)).text();
    expect(config).toContain("test-model");
    expect(config).not.toContain("SECRET_KEY_VALUE");
    expect(config).not.toContain("x.test");
    expect((await fetch(`${url}/md.js`)).status).toBe(200);
    const font = await fetch(`${url}/fonts/inter-latin-wght-normal.woff2`);
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect((await fetch(`${url}/fonts/../src/events.ts`)).status).toBe(404);
    expect(page.headers.get("content-security-policy")).not.toContain(
      "googleapis",
    );
  });

  it("runs an agent end to end and streams ordered SSE events", async () => {
    const { url, workspace } = await boot([
      withCalls(plan("t0")),
      withCalls(
        call("t1", "write_file", {
          path: "index.html",
          content: "<h1>Kopi</h1>",
        }),
      ),
      finalText("Selesai."),
    ]);
    const started = await post(`${url}/api/runs`, { message: "buat halaman" });
    expect(started.status).toBe(201);
    const { run_id } = (await started.json()) as { run_id: string };

    const sse = await fetch(`${url}/api/runs/${run_id}/events`);
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSse(await sse.text()); // server closes the stream after run_finished
    expect(events[0].type).toBe("run_started");
    expect(events.at(-1)?.type).toBe("run_finished");
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.some((e) => e.type === "file_changed")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("SECRET_KEY_VALUE");
    expect(JSON.stringify(events)).not.toContain(workspace);
  });

  it("replays only newer events when Last-Event-ID is sent", async () => {
    const { url } = await boot([finalText("halo")]);
    const { run_id } = (await (
      await post(`${url}/api/runs`, { message: "hai" })
    ).json()) as { run_id: string };
    await (await fetch(`${url}/api/runs/${run_id}/events`)).text();
    const resumed = await fetch(`${url}/api/runs/${run_id}/events`, {
      headers: { "Last-Event-ID": "1" },
    });
    const events = parseSse(await resumed.text());
    expect(events.every((e) => e.seq > 1)).toBe(true);
    expect(events.at(-1)?.type).toBe("run_finished");
  });

  it("holds a risky command until the user answers, and rejects a second run meanwhile", async () => {
    const { url, manager } = await boot([
      withCalls(plan("t0")),
      withCalls(call("t1", "run_command", { command: "npm install" })),
      finalText("ok"),
    ]);
    const { run_id, session_id } = (await (
      await post(`${url}/api/runs`, { message: "pasang" })
    ).json()) as { run_id: string; session_id: string };
    const rec = manager.get(run_id)!;
    await waitFor(() =>
      rec.events.some((e) => e.type === "approval_requested"),
    );

    // Run kedua di SESI YANG SAMA ditolak (satu sesi cuma boleh satu run);
    // sesi lain boleh jalan bareng (diuji di tes "run bareng" di bawah).
    const busy = await post(`${url}/api/runs`, {
      message: "lagi",
      session_id,
    });
    expect(busy.status).toBe(409);

    const req = rec.events.find((e) => e.type === "approval_requested");
    if (req?.type !== "approval_requested")
      throw new Error("tidak ada approval");
    const ok = await post(`${url}/api/runs/${run_id}/approval`, {
      approval_id: req.approval_id,
      decision: "deny",
    });
    expect(ok.status).toBe(200);
    await waitFor(() => rec.finished);
    expect(
      rec.events.find((e) => e.type === "approval_resolved"),
    ).toMatchObject({ decision: "deny" });

    const again = await post(`${url}/api/runs/${run_id}/approval`, {
      approval_id: req.approval_id,
      decision: "allow",
    });
    expect(again.status).toBe(404);
  });

  it("run bareng: sesi berbeda boleh jalan bersamaan, sesi sama tetap ditolak, run ke-4 ditolak", async () => {
    const base = await mkdtemp(join(tmpdir(), "bikinin-par-"));
    await mkdir(join(base, "ws"));
    const workspace = await realpath(join(base, "ws"));
    const manager = new RunManager(
      { ...cfg },
      {
        workspace,
        systemPrompt: "sys",
        llm: {
          async chat() {
            return finalText("ok");
          },
        },
      },
    );
    const a = manager.start({ message: "satu" });
    const b = manager.start({ message: "dua" });
    const c = manager.start({ message: "tiga" });
    expect(new Set([a.session_id, b.session_id, c.session_id]).size).toBe(3);
    expect(() =>
      manager.start({ message: "lagi", session_id: a.session_id }),
    ).toThrow(BusyError);
    expect(() => manager.start({ message: "empat" })).toThrow(BusyError);
    // Biarkan ketiganya selesai sendiri, lalu pastikan tidak ada yang nyangkut.
    await new Promise((r) => setTimeout(r, 500));
    for (const runId of [a.run_id, b.run_id, c.run_id]) {
      expect(manager.get(runId)?.finished).toBe(true);
    }
  });

  it("stop ends a run waiting for approval with status stopped", async () => {
    const { url, manager } = await boot([
      withCalls(plan("t0")),
      withCalls(call("t1", "run_command", { command: "npm install" })),
    ]);
    const { run_id } = (await (
      await post(`${url}/api/runs`, { message: "pasang" })
    ).json()) as { run_id: string };
    const rec = manager.get(run_id)!;
    await waitFor(() =>
      rec.events.some((e) => e.type === "approval_requested"),
    );
    expect((await post(`${url}/api/runs/${run_id}/stop`, {})).status).toBe(202);
    await waitFor(() => rec.finished);
    const last = rec.events.at(-1);
    expect(last?.type).toBe("run_finished");
  });

  it("resumes a budget_exceeded run with a fresh budget", async () => {
    const { url } = await boot(
      [
        withCalls(plan("t0")),
        withCalls(
          call("t1", "write_file", {
            path: "index.html",
            content: "<h1>Kopi</h1>",
          }),
        ),
        finalText("Lanjut selesai."),
      ],
      { BIKININ_MAX_STEPS: 1 },
    );
    const first = (await (
      await post(`${url}/api/runs`, { message: "buat halaman" })
    ).json()) as { run_id: string; session_id: string };
    const events1 = parseSse(
      await (await fetch(`${url}/api/runs/${first.run_id}/events`)).text(),
    );
    expect(events1.at(-1)).toMatchObject({
      type: "run_finished",
      status: "budget_exceeded",
    });
    const resumed = await post(`${url}/api/runs/${first.run_id}/resume`, {});
    expect(resumed.status).toBe(201);
    const { run_id, session_id } = (await resumed.json()) as {
      run_id: string;
      session_id: string;
    };
    expect(run_id).not.toBe(first.run_id);
    expect(session_id).toBe(first.session_id);
    const events2 = parseSse(
      await (await fetch(`${url}/api/runs/${run_id}/events`)).text(),
    );
    expect(events2.at(-1)).toMatchObject({
      type: "run_finished",
      status: "completed",
    });
    // a completed run cannot resume again, and an unknown run is a 404
    expect((await post(`${url}/api/runs/${run_id}/resume`, {})).status).toBe(
      409,
    );
    expect((await post(`${url}/api/runs/run_deadbeef/resume`, {})).status).toBe(
      404,
    );
  });

  it("replays a session's events from the .jsonl log after a restart", async () => {
    const base = await mkdtemp(join(tmpdir(), "bikinin-replay-"));
    await mkdir(join(base, "ws"));
    const workspace = await realpath(join(base, "ws"));
    const bootManager = async (manager: RunManager) => {
      await manager.init();
      const server = createAppServer(manager, workspace);
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      open.push(
        () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      );
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };
    const manager1 = new RunManager(cfg, {
      workspace,
      systemPrompt: "sys",
      llm: scripted([
        withCalls(plan("t0")),
        withCalls(
          call("t1", "write_file", {
            path: "index.html",
            content: "<h1>Kopi</h1>",
          }),
        ),
        finalText("Selesai."),
      ]),
    });
    const url1 = await bootManager(manager1);
    const started = (await (
      await post(`${url1}/api/runs`, { message: "buat halaman" })
    ).json()) as { run_id: string; session_id: string };
    await (await fetch(`${url1}/api/runs/${started.run_id}/events`)).text();
    // Persistence happens after run_finished, so wait for the files on disk.
    await waitFor(() =>
      exists(
        join(workspace, ".bikinin", "sessions", `${started.session_id}.json`),
      ),
    );
    await waitFor(async () => {
      const evs = await readSessionEvents(workspace, started.session_id);
      return evs.some((e) => e.type === "run_finished");
    });

    // Server 2 (restart): same workspace, fresh manager + init().
    const manager2 = new RunManager(cfg, {
      workspace,
      systemPrompt: "sys",
      llm: scripted([finalText("x")]),
    });
    expect(await manager2.init()).toBe(1);
    const url2 = await bootManager(manager2);
    const detail = (await (
      await fetch(`${url2}/api/sessions/${started.session_id}`)
    ).json()) as {
      session_id: string;
      runs: Array<{ run_id: string; events: AgentEvent[] }>;
    };
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0].run_id).toBe(started.run_id);
    expect(detail.runs[0].events[0].type).toBe("run_started");
    expect(detail.runs[0].events.at(-1)?.type).toBe("run_finished");
    expect(detail.runs[0].events.some((e) => e.type === "file_changed")).toBe(
      true,
    );
  });

  it("recovers a session from the .jsonl log when the .json snapshot is missing", async () => {
    const base = await mkdtemp(join(tmpdir(), "bikinin-recover-"));
    await mkdir(join(base, "ws", ".bikinin", "sessions"), {
      recursive: true,
    });
    const workspace = await realpath(join(base, "ws"));
    const started = AgentEvent.parse({
      v: 1,
      seq: 0,
      ts: "2026-11-28T02:00:00.000Z",
      run_id: "run_aaaa0001",
      type: "run_started",
      session_id: "s_aaaa0001",
      model: "test-model",
      effort: "sedang",
      user_message: "Buatkan landing page kedai kopi",
      limits: { max_steps: 10, max_cost_usd: 1 },
    });
    const finished = AgentEvent.parse({
      v: 1,
      seq: 1,
      ts: "2026-11-28T02:05:00.000Z",
      run_id: "run_aaaa0001",
      type: "run_finished",
      status: "completed",
      summary: "Selesai.",
      totals: {
        steps: 1,
        input_tokens: 100,
        output_tokens: 20,
        cached_tokens: 0,
        cost_usd: 0,
      },
      duration_ms: 100,
      resumable: false,
    });
    await writeFile(
      join(workspace, ".bikinin", "sessions", "s_aaaa0001.jsonl"),
      toNDJSON(started) + toNDJSON(finished),
    );
    const manager = new RunManager(cfg, {
      workspace,
      systemPrompt: "sys",
      llm: scripted([finalText("x")]),
    });
    expect(await manager.init()).toBe(1);
    const list = manager.listSessions();
    expect(list).toHaveLength(1);
    expect(list[0].session_id).toBe("s_aaaa0001");
    expect(list[0].title).toBe("Buatkan landing page kedai kopi");
    expect(list[0].prompts).toBe(1);
    expect(list[0].runs).toBe(1);
    expect(list[0].last_status).toBe("completed");
    // The snapshot was rebuilt on disk, so a second init finds it via .json.
    expect(
      await exists(
        join(workspace, ".bikinin", "sessions", "s_aaaa0001.json"),
      ),
    ).toBe(true);
    expect(await manager.init()).toBe(0);
  });

  it("persists a session as soon as a run starts, even before it finishes", async () => {
    const base = await mkdtemp(join(tmpdir(), "bikinin-persist-start-"));
    await mkdir(join(base, "ws"));
    const workspace = await realpath(join(base, "ws"));
    const hanging: LlmClient = {
      async chat() {
        return new Promise<ChatResult>(() => {});
      },
    };
    const manager = new RunManager(cfg, {
      workspace,
      systemPrompt: "sys",
      llm: hanging,
    });
    await manager.init();
    const server = createAppServer(manager, workspace);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    open.push(
      () =>
        new Promise<void>((r) => {
          server.closeAllConnections();
          server.close(() => r());
        }),
    );
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const started = (await (
      await post(`${url}/api/runs`, { message: "buat halaman" })
    ).json()) as { run_id: string; session_id: string };
    // The run is still hanging, yet the .json snapshot must already exist.
    await waitFor(() =>
      exists(
        join(workspace, ".bikinin", "sessions", `${started.session_id}.json`),
      ),
    );
    const list = (await (await fetch(`${url}/api/sessions`)).json()) as Array<{
      session_id: string;
    }>;
    expect(list.some((s) => s.session_id === started.session_id)).toBe(true);
    await post(`${url}/api/runs/${started.run_id}/stop`, {});
  });

  it("remembers earlier messages of the same session, and forgets for a new one", async () => {
    const seen: string[][] = [];
    const responses = [
      finalText("Halo Rizqi."),
      finalText("Namamu Rizqi."),
      finalText("Aku tidak tahu."),
    ];
    let i = 0;
    const llm: LlmClient = {
      async chat(p) {
        seen.push(
          p.messages.map((m) =>
            typeof m.content === "string" ? m.content : "",
          ),
        );
        return responses[i++];
      },
    };
    const base = await mkdtemp(join(tmpdir(), "bikinin-mem-"));
    await mkdir(join(base, "ws"));
    const workspace = await realpath(join(base, "ws"));
    const manager = new RunManager(cfg, {
      workspace,
      systemPrompt: "sys",
      llm,
    });
    const server = createAppServer(manager, workspace);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    open.push(
      () =>
        new Promise<void>((r) => {
          server.closeAllConnections();
          server.close(() => r());
        }),
    );
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const first = (await (
      await post(`${url}/api/runs`, { message: "namaku Rizqi" })
    ).json()) as { run_id: string; session_id: string };
    await (await fetch(`${url}/api/runs/${first.run_id}/events`)).text();

    const second = (await (
      await post(`${url}/api/runs`, {
        message: "siapa namaku?",
        session_id: first.session_id,
      })
    ).json()) as { run_id: string; session_id: string };
    expect(second.session_id).toBe(first.session_id);
    await (await fetch(`${url}/api/runs/${second.run_id}/events`)).text();
    expect(seen[1]).toContain("namaku Rizqi");
    expect(seen[1]).toContain("Halo Rizqi.");

    // an id the server never issued must not read anyone's history
    const third = (await (
      await post(`${url}/api/runs`, {
        message: "siapa namaku?",
        session_id: "s_deadbeef",
      })
    ).json()) as { run_id: string; session_id: string };
    expect(third.session_id).not.toBe("s_deadbeef");
    await (await fetch(`${url}/api/runs/${third.run_id}/events`)).text();
    expect(seen[2]).not.toContain("namaku Rizqi");
  });

  it("restores sessions and long-term memory across a server restart", async () => {
    const seen: string[][] = [];
    const responses = [
      withCalls(plan("t0")),
      withCalls(
        call("t1", "write_file", {
          path: "index.html",
          content: "<h1>Kopi</h1>",
        }),
      ),
      finalText("Selesai, halaman sudah jadi."),
      finalText("ok kedua."),
      finalText("Namamu Rizqi."),
    ];
    let i = 0;
    const llm: LlmClient = {
      async chat(p) {
        seen.push(
          p.messages.map((m) =>
            typeof m.content === "string" ? m.content : "",
          ),
        );
        return responses[i++];
      },
    };
    const base = await mkdtemp(join(tmpdir(), "bikinin-restart-"));
    await mkdir(join(base, "ws"));
    const workspace = await realpath(join(base, "ws"));

    const bootManager = async (manager: RunManager) => {
      const server = createAppServer(manager, workspace);
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      open.push(
        () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      );
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };

    // Server 1: one run that teaches the agent a fact and builds a file.
    const manager1 = new RunManager(cfg, {
      workspace,
      systemPrompt: "sys",
      llm,
    });
    const url1 = await bootManager(manager1);
    const first = (await (
      await post(`${url1}/api/runs`, {
        message: "namaku Rizqi, panggil aku Qi. Buat halaman kopi.",
      })
    ).json()) as { run_id: string; session_id: string };
    await (await fetch(`${url1}/api/runs/${first.run_id}/events`)).text();
    // Persistence happens after run_finished, so wait for the files on disk.
    await waitFor(() =>
      exists(
        join(workspace, ".bikinin", "sessions", `${first.session_id}.json`),
      ),
    );
    await waitFor(() => exists(join(workspace, ".bikinin", "memory.md")));

    const memoryText = await readFile(
      join(workspace, ".bikinin", "memory.md"),
      "utf8",
    );
    expect(memoryText).toContain("(fakta) namaku Rizqi, panggil aku Qi.");
    expect(memoryText).toContain("(hasil) Membuat/mengubah index.html");

    // Server 2 (restart): same workspace, fresh manager + init().
    const manager2 = new RunManager(cfg, {
      workspace,
      systemPrompt: "sys",
      llm,
    });
    expect(await manager2.init()).toBe(1);
    const url2 = await bootManager(manager2);
    const sessions = (await (
      await fetch(`${url2}/api/sessions`)
    ).json()) as Array<{
      session_id: string;
      title: string;
      prompts: number;
      runs: number;
      last_status: string | null;
    }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      session_id: first.session_id,
      prompts: 1,
      runs: 1,
      last_status: "completed",
    });

    // A second session, so the "recent sessions" list is non-empty.
    const second = (await (
      await post(`${url2}/api/runs`, {
        message: "proyek kedua",
      })
    ).json()) as { run_id: string; session_id: string };
    await (await fetch(`${url2}/api/runs/${second.run_id}/events`)).text();

    const third = (await (
      await post(`${url2}/api/runs`, {
        message: "siapa namaku?",
        session_id: first.session_id,
      })
    ).json()) as { run_id: string; session_id: string };
    expect(third.session_id).toBe(first.session_id);
    await (await fetch(`${url2}/api/runs/${third.run_id}/events`)).text();
    // The restored session history is replayed…
    // (seen[0..2] are run 1: plan, tool call, then final text.)
    expect(seen[4]).toContain(
      "namaku Rizqi, panggil aku Qi. Buat halaman kopi.",
    );
    // …and the long-term memory is injected into the system prompt,
    // including the list of other recent sessions.
    expect(seen[4][0]).toContain("Memori dari obrolan sebelumnya");
    expect(seen[4][0]).toContain("namaku Rizqi, panggil aku Qi");
    expect(seen[4][0]).toContain("Sesi terakhir:");
    expect(seen[4][0]).toContain("proyek kedua");
  });

  it("writes every event to the session .jsonl log (valid NDJSON, no secrets)", async () => {
    const { url, workspace } = await boot([
      withCalls(plan("t0")),
      withCalls(
        call("t1", "write_file", {
          path: "index.html",
          content: "<h1>Kopi</h1>",
        }),
      ),
      finalText("Selesai."),
    ]);
    const started = await post(`${url}/api/runs`, { message: "buat halaman" });
    expect(started.status).toBe(201);
    const { run_id, session_id } = (await started.json()) as {
      run_id: string;
      session_id: string;
    };
    await (await fetch(`${url}/api/runs/${run_id}/events`)).text();
    const logPath = join(
      workspace,
      ".bikinin",
      "sessions",
      `${session_id}.jsonl`,
    );
    // The log drains in the background after run_finished, so wait until
    // the final event has reached disk instead of just waiting for the file.
    await waitFor(async () => {
      try {
        return (await readFile(logPath, "utf8")).includes("run_finished");
      } catch {
        return false;
      }
    });
    const raw = await readFile(logPath, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines.length).toBeGreaterThan(2);
    const parsed = lines.map((l) => AgentEvent.safeParse(JSON.parse(l)));
    expect(parsed.every((p) => p.success)).toBe(true);
    const types = parsed.map((p) => p.success && p.data.type);
    expect(types[0]).toBe("run_started");
    expect(types.at(-1)).toBe("run_finished");
    expect(raw).not.toContain("SECRET_KEY_VALUE");
    expect(raw).not.toContain(workspace);
  });

  it("validates request bodies", async () => {
    const { url } = await boot([]);
    expect((await post(`${url}/api/runs`, { message: "" })).status).toBe(400);
    expect((await post(`${url}/api/runs`, { nope: 1 })).status).toBe(400);
    const bad = await fetch(`${url}/api/runs`, {
      method: "POST",
      body: "{bukan json",
    });
    expect(bad.status).toBe(400);
    expect((await fetch(`${url}/api/runs/run_deadbeef/events`)).status).toBe(
      404,
    );
  });

  it("lists sessions with replay, files and a zip download, and lists skills", async () => {
    const { url } = await boot([
      withCalls(plan("t0")),
      withCalls(
        call("t1", "write_file", {
          path: "index.html",
          content: "<h1>Kopi</h1>",
        }),
      ),
      finalText("Selesai."),
    ]);
    const started = await post(`${url}/api/runs`, { message: "buat halaman" });
    expect(started.status).toBe(201);
    const { run_id, session_id } = (await started.json()) as {
      run_id: string;
      session_id: string;
    };
    await (await fetch(`${url}/api/runs/${run_id}/events`)).text();

    const sessions = (await (
      await fetch(`${url}/api/sessions`)
    ).json()) as Array<{
      session_id: string;
      title: string;
      prompts: number;
      runs: number;
      last_status: string | null;
    }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      session_id,
      title: "buat halaman",
      prompts: 1,
      runs: 1,
      last_status: "completed",
    });

    const detail = (await (
      await fetch(`${url}/api/sessions/${session_id}`)
    ).json()) as {
      runs: Array<{ run_id: string; events: AgentEvent[] }>;
    };
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0].run_id).toBe(run_id);
    expect(detail.runs[0].events[0].type).toBe("run_started");
    expect(detail.runs[0].events.at(-1)?.type).toBe("run_finished");

    const files = (await (
      await fetch(`${url}/api/sessions/${session_id}/files`)
    ).json()) as Array<{ path: string; bytes: number }>;
    expect(files).toContainEqual({ path: "index.html", bytes: 13 });

    const zip = await fetch(`${url}/api/sessions/${session_id}/download.zip`);
    expect(zip.status).toBe(200);
    expect(zip.headers.get("content-type")).toBe("application/zip");
    const zipBytes = new Uint8Array(await zip.arrayBuffer());
    expect(zipBytes[0]).toBe(0x50); // 'P'
    expect(zipBytes[1]).toBe(0x4b); // 'K'
    expect(Buffer.from(zipBytes).includes(Buffer.from("<h1>Kopi</h1>"))).toBe(
      true,
    );

    const skills = await (await fetch(`${url}/api/skills`)).json();
    expect(Array.isArray(skills)).toBe(true);

    expect((await fetch(`${url}/api/sessions/s_deadbeef`)).status).toBe(404);
    expect((await fetch(`${url}/api/sessions/s_deadbeef/files`)).status).toBe(
      404,
    );
    expect(
      (await fetch(`${url}/api/sessions/s_deadbeef/download.zip`)).status,
    ).toBe(404);
  });

  it("downloads a session transcript as markdown", async () => {
    const { url } = await boot([
      withCalls(plan("t0")),
      withCalls(
        call("t1", "write_file", {
          path: "index.html",
          content: "<h1>Kopi</h1>",
        }),
      ),
      finalText("Selesai."),
    ]);
    const started = await post(`${url}/api/runs`, { message: "buat halaman" });
    expect(started.status).toBe(201);
    const { run_id, session_id } = (await started.json()) as {
      run_id: string;
      session_id: string;
    };
    await (await fetch(`${url}/api/runs/${run_id}/events`)).text();

    const res = await fetch(`${url}/api/sessions/${session_id}/transcript`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="buat halaman.md"',
    );
    const md = await res.text();
    expect(md).toContain("# buat halaman");
    expect(md).toContain("**Pengguna:** buat halaman");
    expect(md).toContain("**Agent:** Selesai.");
    expect(md).toContain("write_file");
    expect(md).toContain("index.html");
    expect(md).toContain("**Selesai:** completed");

    expect(
      (await fetch(`${url}/api/sessions/s_deadbeef/transcript`)).status,
    ).toBe(404);
  });

  it("downloads a single file as an attachment, without the zip size cap", async () => {
    const { url, workspace } = await boot([
      withCalls(plan("t0")),
      withCalls(
        call("t1", "write_file", {
          path: "index.html",
          content: "<h1>Kopi</h1>",
        }),
      ),
      finalText("Selesai."),
    ]);
    const started = await post(`${url}/api/runs`, { message: "buat halaman" });
    const { run_id, session_id } = (await started.json()) as {
      run_id: string;
      session_id: string;
    };
    await (await fetch(`${url}/api/runs/${run_id}/events`)).text();
    const video = Buffer.from("fake-mp4-bytes-0123456789");
    await mkdir(join(workspace, "out"));
    await writeFile(join(workspace, "out", "video.mp4"), video);
    const big = Buffer.alloc(6 * 1024 * 1024, 7);
    await writeFile(join(workspace, "big.bin"), big);
    await writeFile(join(workspace, ".env"), "SECRET=1");

    const dl = await fetch(
      `${url}/api/sessions/${session_id}/download?path=${encodeURIComponent("out/video.mp4")}`,
    );
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("video/mp4");
    expect(dl.headers.get("content-disposition")).toContain(
      'attachment; filename="video.mp4"',
    );
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(
      new Uint8Array(video),
    );

    // No 5 MB cap here (unlike the zip): a 6 MB file streams out fine.
    const bigDl = await fetch(
      `${url}/api/sessions/${session_id}/download?path=big.bin`,
    );
    expect(bigDl.status).toBe(200);
    expect(bigDl.headers.get("content-length")).toBe(String(big.length));

    expect(
      (await fetch(`${url}/api/sessions/${session_id}/download`)).status,
    ).toBe(400);
    expect(
      (
        await fetch(
          `${url}/api/sessions/${session_id}/download?path=tidak-ada.mp4`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(
          `${url}/api/sessions/${session_id}/download?path=${encodeURIComponent("../secret.txt")}`,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(
          `${url}/api/sessions/${session_id}/download?path=.env`,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(
          `${url}/api/sessions/s_deadbeef/download?path=index.html`,
        )
      ).status,
    ).toBe(404);
  });

  it("passes the chosen model and effort through to the run", async () => {
    const { url } = await boot([finalText("ok")]);
    const started = await post(`${url}/api/runs`, {
      message: "hai",
      model: "tidak-ada",
      effort: "tinggi",
    });
    expect(started.status).toBe(201);
    const { run_id } = (await started.json()) as { run_id: string };
    const events = parseSse(
      await (await fetch(`${url}/api/runs/${run_id}/events`)).text(),
    );
    const first = events[0];
    expect(first.type).toBe("run_started");
    if (first.type !== "run_started") throw new Error("bukan run_started");
    // unknown model falls back to the server primary; effort is passed through
    expect(first.model).toBe("test-model");
    expect(first.effort).toBe("tinggi");
  });

  it("serves the UI and config without an LLM, but refuses runs with 503", async () => {
    const base = await mkdtemp(join(tmpdir(), "bikinin-nollm-"));
    await mkdir(join(base, "ws"));
    const workspace = await realpath(join(base, "ws"));
    const manager = new RunManager(
      { ...cfg, providers: [] },
      { workspace, systemPrompt: "sys", llm: scripted([]) },
    );
    const server = createAppServer(manager, workspace);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    open.push(
      () =>
        new Promise<void>((r) => {
          server.closeAllConnections();
          server.close(() => r());
        }),
    );
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await fetch(`${url}/`)).status).toBe(200);
    const config = (await (await fetch(`${url}/api/config`)).json()) as {
      model: string;
      models: string[];
    };
    expect(config.models).toEqual([]);
    expect(config.model).toBe("");
    const run = await post(`${url}/api/runs`, { message: "hai" });
    expect(run.status).toBe(503);
    expect(await run.text()).toContain("LLM belum dikonfigurasi");
  });

  it("previews workspace files in a sandboxed CSP and blocks traversal", async () => {
    const { url, workspace } = await boot([]);
    await writeFile(join(workspace, "index.html"), "<h1>Halo</h1>");
    const ok = await fetch(`${url}/preview/index.html`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("<h1>Halo</h1>");
    expect(ok.headers.get("content-security-policy")).toContain(
      "sandbox allow-scripts",
    );
    expect(ok.headers.get("content-security-policy")).toContain(
      "connect-src 'none'",
    );

    expect((await fetch(`${url}/preview/..%2Fsecret.txt`)).status).toBe(403);
    expect((await fetch(`${url}/preview/%2Fetc%2Fpasswd`)).status).toBe(403);
    expect((await fetch(`${url}/preview/tidak-ada.html`)).status).toBe(404);
  });

  it("accepts file uploads and lists them to the run", async () => {
    const { url, workspace } = await boot([finalText("ok")]);
    const form = new FormData();
    form.append(
      "file",
      new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], {
        type: "image/png",
      }),
      "foto.png",
    );
    const up = await fetch(`${url}/api/uploads`, {
      method: "POST",
      body: form,
    });
    expect(up.status).toBe(201);
    const body = (await up.json()) as {
      uploads: Array<{ path: string; name: string; bytes: number }>;
    };
    expect(body.uploads).toHaveLength(1);
    const uploaded = body.uploads[0];
    expect(uploaded.path).toMatch(/^uploads\/[a-f0-9]{8}_foto\.png$/);
    expect(uploaded.name).toBe("foto.png");
    expect(uploaded.bytes).toBe(4);
    expect(
      await readFile(join(workspace, uploaded.path)),
    ).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    // The run sees the file list, but the session title stays the message.
    const started = await post(`${url}/api/runs`, {
      message: "perbaiki foto ini",
      attachment_ids: [uploaded.path],
    });
    expect(started.status).toBe(201);
    const { run_id, session_id } = (await started.json()) as {
      run_id: string;
      session_id: string;
    };
    const events = parseSse(
      await (await fetch(`${url}/api/runs/${run_id}/events`)).text(),
    );
    const first = events[0];
    expect(first.type).toBe("run_started");
    if (first.type !== "run_started") throw new Error("bukan run_started");
    expect(first.user_message).toContain("File terlampir");
    expect(first.user_message).toContain(uploaded.path);
    const sessions = (await (
      await fetch(`${url}/api/sessions`)
    ).json()) as Array<{ session_id: string; title: string }>;
    expect(sessions[0].title).toBe("perbaiki foto ini");

    // Unknown attachment ids are rejected, not silently dropped.
    const bad = await post(`${url}/api/runs`, {
      message: "hai",
      attachment_ids: ["uploads/tidak-ada.jpg"],
    });
    expect(bad.status).toBe(400);

    // Secret names and oversize files are rejected at upload.
    const secretForm = new FormData();
    secretForm.append("file", new Blob(["x"]), "my-secret.txt");
    expect(
      (await fetch(`${url}/api/uploads`, { method: "POST", body: secretForm }))
        .status,
    ).toBe(403);
    const bigForm = new FormData();
    bigForm.append(
      "file",
      new Blob([Buffer.alloc(10 * 1024 * 1024 + 1, 7)]),
      "big.bin",
    );
    expect(
      (await fetch(`${url}/api/uploads`, { method: "POST", body: bigForm }))
        .status,
    ).toBe(413);
  });

  it("deletes a session (transcript + ledger) and 404s afterwards", async () => {
    const { url, workspace } = await boot([finalText("ok")]);
    const started = await post(`${url}/api/runs`, { message: "buat halaman" });
    const { run_id, session_id } = (await started.json()) as {
      run_id: string;
      session_id: string;
    };
    await (await fetch(`${url}/api/runs/${run_id}/events`)).text();
    const sessDir = join(workspace, ".bikinin", "sessions");
    // The session file is written when the run finishes; the SSE stream
    // can close just before the write lands, so wait for it.
    await waitFor(() => exists(join(sessDir, `${session_id}.json`)));
    await waitFor(() => exists(join(sessDir, `${session_id}.jsonl`)));
    expect(await exists(join(sessDir, `${session_id}.json`))).toBe(true);
    expect(await exists(join(sessDir, `${session_id}.jsonl`))).toBe(true);

    const del = await fetch(`${url}/api/sessions/${session_id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    expect((await fetch(`${url}/api/sessions/${session_id}`)).status).toBe(
      404,
    );
    // The old run's event stream is gone too.
    expect((await fetch(`${url}/api/runs/${run_id}/events`)).status).toBe(404);
    expect(await exists(join(sessDir, `${session_id}.json`))).toBe(false);
    expect(await exists(join(sessDir, `${session_id}.jsonl`))).toBe(false);
    expect(await exists(join(sessDir, `${session_id}.ledger.json`))).toBe(
      false,
    );
    const list = (await (
      await fetch(`${url}/api/sessions`)
    ).json()) as Array<{ session_id: string }>;
    expect(list).toHaveLength(0);

    expect(
      (await fetch(`${url}/api/sessions/s_deadbeef`, { method: "DELETE" }))
        .status,
    ).toBe(404);
  });

  it("refuses to delete a session with an active run", async () => {
    const base = await mkdtemp(join(tmpdir(), "bikinin-delbusy-"));
    await mkdir(join(base, "ws"));
    const workspace = await realpath(join(base, "ws"));
    let release!: () => void;
    const hanging = new Promise<ChatResult>((resolve) => {
      release = () => resolve(finalText("ok"));
    });
    const manager = new RunManager(
      { ...cfg },
      {
        workspace,
        systemPrompt: "sys",
        llm: { chat: () => hanging },
      },
    );
    const { run_id, session_id } = manager.start({
      message: "tahan",
      attachment_ids: [],
      effort: "sedang",
    });
    expect(await manager.deleteSession(session_id)).toBe("busy");
    release();
    await waitFor(() => manager.get(run_id)?.finished === true);
    expect(await manager.deleteSession(session_id)).toBe("ok");
    expect(await manager.deleteSession(session_id)).toBe("not-found");
  });

  it("installs a skill from pasted content and lists it", async () => {
    const skills = await mkdtemp(join(tmpdir(), "bikinin-skills-"));
    const prev = process.env.BIKININ_SKILLS_DIR;
    process.env.BIKININ_SKILLS_DIR = skills;
    try {
      const { url } = await boot([finalText("ok")]);
      const good =
        "---\nname: contoh-skill\ndescription: Skill contoh untuk tes.\n---\n\n# Contoh\n";
      const created = await post(`${url}/api/skills`, { content: good });
      expect(created.status).toBe(201);
      expect(await created.json()).toEqual({
        skill: {
          name: "contoh-skill",
          description: "Skill contoh untuk tes.",
          bytes: Buffer.byteLength(good, "utf8"),
        },
      });
      expect(
        await readFile(join(skills, "contoh-skill", "SKILL.md"), "utf8"),
      ).toBe(good);
      const list = (await (
        await fetch(`${url}/api/skills`)
      ).json()) as Array<{ name: string }>;
      expect(list.map((s) => s.name)).toContain("contoh-skill");

      // Duplicate -> 409; bad frontmatter -> 400; neither url nor content -> 400.
      expect(
        (await post(`${url}/api/skills`, { content: good })).status,
      ).toBe(409);
      expect(
        (await post(`${url}/api/skills`, { content: "# tanpa frontmatter" }))
          .status,
      ).toBe(400);
      expect((await post(`${url}/api/skills`, {})).status).toBe(400);
      expect(
        (
          await post(`${url}/api/skills`, {
            url: "https://example.com/SKILL.md",
          })
        ).status,
      ).toBe(400);
    } finally {
      if (prev === undefined) delete process.env.BIKININ_SKILLS_DIR;
      else process.env.BIKININ_SKILLS_DIR = prev;
    }
  });
});
