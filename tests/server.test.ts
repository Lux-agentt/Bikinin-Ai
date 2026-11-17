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
import { AgentEvent } from "../src/events.js";
import type { ChatResult, LlmClient, ToolCallReq } from "../src/llm/client.js";
import { createAppServer } from "../src/server/http.js";
import { RunManager } from "../src/server/runs.js";

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

async function boot(responses: ChatResult[]) {
  const base = await mkdtemp(join(tmpdir(), "bikinin-srv-"));
  await mkdir(join(base, "ws"));
  const workspace = await realpath(join(base, "ws"));
  await writeFile(join(base, "secret.txt"), "di luar workspace");
  const manager = new RunManager(cfg, {
    workspace,
    systemPrompt: "sys",
    llm: scripted(responses),
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
      withCalls(call("t1", "run_command", { command: "npm install" })),
      finalText("ok"),
    ]);
    const { run_id } = (await (
      await post(`${url}/api/runs`, { message: "pasang" })
    ).json()) as { run_id: string };
    const rec = manager.get(run_id)!;
    await waitFor(() =>
      rec.events.some((e) => e.type === "approval_requested"),
    );

    const busy = await post(`${url}/api/runs`, { message: "lagi" });
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

  it("stop ends a run waiting for approval with status stopped", async () => {
    const { url, manager } = await boot([
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
    // (seen[0] and seen[1] are both run 1: tool call, then final text.)
    expect(seen[3]).toContain(
      "namaku Rizqi, panggil aku Qi. Buat halaman kopi.",
    );
    // …and the long-term memory is injected into the system prompt,
    // including the list of other recent sessions.
    expect(seen[3][0]).toContain("Memori dari obrolan sebelumnya");
    expect(seen[3][0]).toContain("namaku Rizqi, panggil aku Qi");
    expect(seen[3][0]).toContain("Sesi terakhir:");
    expect(seen[3][0]).toContain("proyek kedua");
  });

  it("writes every event to the session .jsonl log (valid NDJSON, no secrets)", async () => {
    const { url, workspace } = await boot([
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
});
