// Fase 6 (integrator): diff, self-check, plan mode, vision usage, git, MCP wiring.
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent, type AgentDeps } from "../src/agent/loop.js";
import { unifiedDiff } from "../src/agent/diff.js";
import {
  formatSelfCheckFeedback,
  runSelfCheck,
} from "../src/agent/self-check.js";
import {
  createEmitter,
  ToolName,
  type AgentEvent,
  type EventType,
} from "../src/events.js";
import type { ChatResult, LlmClient, ToolCallReq } from "../src/llm/client.js";
import { TOOLS } from "../src/tools/registry.js";
import { tempWorkspace } from "./helpers.js";

const usage = { input_tokens: 100, output_tokens: 20, cached_tokens: 0 };

function call(id: string, name: string, args: unknown): ToolCallReq {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}
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

function ofType<T extends EventType>(events: AgentEvent[], type: T) {
  return events.filter(
    (e): e is Extract<AgentEvent, { type: T }> => e.type === type,
  );
}

async function run(
  responses: ChatResult[],
  overrides: Partial<AgentDeps> = {},
) {
  const workspace = await tempWorkspace();
  const events: AgentEvent[] = [];
  const emit = createEmitter("run_test", (e) => events.push(e));
  const deps: AgentDeps = {
    llm: scripted(responses),
    model: "test-model",
    systemPrompt: "sys",
    message: "tes fase 6",
    sessionId: "s_test",
    workspace,
    limits: { maxCostUsd: 1 },
    prices: { inPerM: 1, outPerM: 2 },
    emit,
    approve: async () => false,
    ...overrides,
  };
  const result = await runAgent(deps);
  return { workspace, events, result };
}

const planCall = (id: string) =>
  call(id, "update_plan", {
    items: [{ text: "Kerjakan tugas", status: "doing" }],
  });

describe("unifiedDiff", () => {
  it("diffs a new file as all additions", () => {
    const d = unifiedDiff("", "a\nb\n", "x.txt");
    expect(d).toContain("--- a/x.txt");
    expect(d).toContain("+++ b/x.txt");
    expect(d).toContain("+a");
    expect(d).toContain("+b");
  });

  it("shows changed lines with context and hunk headers", () => {
    const d = unifiedDiff("a\nb\nc\n", "a\nB\nc\n", "x.txt");
    expect(d).toContain("-b");
    expect(d).toContain("+B");
    expect(d).toContain("@@");
    expect(d).toContain(" a");
  });

  it("returns empty for identical content", () => {
    expect(unifiedDiff("a\n", "a\n", "x.txt")).toBe("");
  });

  it("truncates long diffs", () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const d = unifiedDiff("", big, "x.txt");
    expect(d.length).toBeLessThanOrEqual(2100);
    expect(d).toContain("dipotong");
  });
});

describe("runSelfCheck", () => {
  it("passes a clean file and a non-empty answer", async () => {
    const ws = await tempWorkspace();
    await writeFile(join(ws, "a.txt"), "hello\n");
    const r = await runSelfCheck({
      workspace: ws,
      files: ["a.txt"],
      finalText: "Selesai.",
    });
    expect(r.outcome).toBe("pass");
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it("fails on placeholder text and reports it", async () => {
    const ws = await tempWorkspace();
    await writeFile(join(ws, "a.txt"), "TODO: isi nanti\n");
    const r = await runSelfCheck({
      workspace: ws,
      files: ["a.txt"],
      finalText: "Selesai.",
    });
    expect(r.outcome).toBe("fail");
    expect(r.checks.find((c) => c.name.startsWith("placeholder"))?.ok).toBe(
      false,
    );
    expect(formatSelfCheckFeedback(r, 1)).toContain("TODO");
  });

  it("fails on an empty changed file and a missing file", async () => {
    const ws = await tempWorkspace();
    await writeFile(join(ws, "empty.txt"), "");
    const r = await runSelfCheck({
      workspace: ws,
      files: ["empty.txt", "hilang.txt"],
      finalText: "Selesai.",
    });
    expect(r.outcome).toBe("fail");
    expect(r.checks.filter((c) => !c.ok).length).toBeGreaterThanOrEqual(2);
  });

  const BARE_PAGE = `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><title>Kopi</title></head>
<body><h1>Kopi</h1><p>Deskripsi.</p></body></html>
`;
  const STYLED_PAGE = `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><title>Kopi</title>
<style>body{margin:0;background:#171310;color:#f5efe6;font-family:system-ui,sans-serif;line-height:1.6}</style></head>
<body><header><strong>Kopi</strong><nav><ul class="nav-list"><li><a href="#menu">Menu</a></li></ul></nav></header>
<main><h1>Kopi</h1><p>Deskripsi.</p></main></body></html>
`;

  it("fails a full HTML page without real CSS", async () => {
    const ws = await tempWorkspace();
    await writeFile(join(ws, "index.html"), BARE_PAGE);
    const r = await runSelfCheck({
      workspace: ws,
      files: ["index.html"],
      finalText: "Selesai.",
    });
    expect(r.outcome).toBe("fail");
    expect(r.checks.find((c) => c.name === "tampilan index.html")?.ok).toBe(
      false,
    );
    expect(formatSelfCheckFeedback(r, 1)).toMatch(/CSS/);
  });

  it("passes a full HTML page with real CSS and a classed nav list", async () => {
    const ws = await tempWorkspace();
    await writeFile(join(ws, "index.html"), STYLED_PAGE);
    const r = await runSelfCheck({
      workspace: ws,
      files: ["index.html"],
      finalText: "Selesai.",
    });
    expect(r.outcome).toBe("pass");
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it("fails a nav that is still a bare bullet list", async () => {
    const ws = await tempWorkspace();
    const bareNav = STYLED_PAGE.replace(
      '<ul class="nav-list">',
      "<ul>",
    );
    await writeFile(join(ws, "index.html"), bareNav);
    const r = await runSelfCheck({
      workspace: ws,
      files: ["index.html"],
      finalText: "Selesai.",
    });
    expect(r.outcome).toBe("fail");
    expect(r.checks.find((c) => c.name === "nav index.html")?.ok).toBe(false);
    // CSS checks still pass — only the nav is at fault.
    expect(r.checks.find((c) => c.name === "css index.html")?.ok).toBe(true);
  });

  it("fails CSS without a font and without a color", async () => {
    const ws = await tempWorkspace();
    const noFont = STYLED_PAGE.replace(
      "font-family:system-ui,sans-serif;",
      "",
    ).replace("#171310", "var(--bg)").replace("#f5efe6", "var(--text)");
    await writeFile(join(ws, "index.html"), noFont);
    const r = await runSelfCheck({
      workspace: ws,
      files: ["index.html"],
      finalText: "Selesai.",
    });
    expect(r.outcome).toBe("fail");
    expect(r.checks.find((c) => c.name === "css index.html")?.ok).toBe(false);
  });

  it("passes an external stylesheet that is part of the run", async () => {
    const ws = await tempWorkspace();
    await writeFile(
      join(ws, "index.html"),
      `<!doctype html>\n<html lang="id"><head><meta charset="utf-8"><link rel="stylesheet" href="app.css"></head>\n<body><h1>Kopi</h1></body></html>\n`,
    );
    await writeFile(
      join(ws, "app.css"),
      "body{background:#171310;color:#f5efe6;font-family:system-ui,sans-serif}\n",
    );
    const r = await runSelfCheck({
      workspace: ws,
      files: ["index.html", "app.css"],
      finalText: "Selesai.",
    });
    expect(r.outcome).toBe("pass");
  });

  it("skips HTML fragments and unverifiable external stylesheets", async () => {
    const ws = await tempWorkspace();
    await writeFile(join(ws, "frag.html"), "<section><h2>Cuplikan</h2></section>\n");
    await writeFile(
      join(ws, "index.html"),
      `<!doctype html>\n<html lang="id"><head><meta charset="utf-8"><link rel="stylesheet" href="lama.css"></head>\n<body><h1>Kopi</h1></body></html>\n`,
    );
    const r = await runSelfCheck({
      workspace: ws,
      files: ["frag.html", "index.html"],
      finalText: "Selesai.",
    });
    expect(r.outcome).toBe("pass");
    expect(r.checks.some((c) => c.name.startsWith("tampilan frag"))).toBe(
      false,
    );
    expect(
      r.checks.find((c) => c.name === "css index.html")?.detail,
    ).toMatch(/tidak diperiksa/);
  });
});

describe("Fase 6 wiring", () => {
  it("registers inspect_image, git, mcp_call and request_plan_approval", () => {
    for (const name of [
      "inspect_image",
      "git",
      "mcp_call",
      "request_plan_approval",
    ] as const) {
      expect(ToolName.parse(name)).toBe(name);
      expect(TOOLS.some((t) => t.name === name)).toBe(true);
    }
  });

  it("emits a passing verification and a diff on write_file", async () => {
    const { events, result } = await run([
      withCalls(
        planCall("t0"),
        call("t1", "write_file", { path: "a.txt", content: "hello\n" }),
      ),
      finalText("Selesai."),
    ]);
    expect(result.status).toBe("completed");
    const v = ofType(events, "verification");
    expect(v).toHaveLength(1);
    expect(v[0].outcome).toBe("pass");
    expect(v[0].fixes).toBe(0);
    const fc = ofType(events, "file_changed")[0];
    expect(fc.diff).toContain("+hello");
  });

  it("self-check finds a placeholder and the model fixes it", async () => {
    const { workspace, events, result } = await run([
      withCalls(
        planCall("t0"),
        call("t1", "write_file", { path: "a.txt", content: "TODO: isi\n" }),
      ),
      finalText("Selesai."),
      withCalls(
        call("t2", "write_file", { path: "a.txt", content: "sudah diisi\n" }),
      ),
      finalText("Sudah diperbaiki."),
    ]);
    expect(result.status).toBe("completed");
    const v = ofType(events, "verification");
    expect(v.map((e) => e.outcome)).toEqual(["fail", "pass"]);
    expect(v[1].fixes).toBe(1);
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
      "sudah diisi\n",
    );
  });

  it("self-check gagal dua kali: berhenti setelah 1 putaran perbaikan (bukan 2)", async () => {
    // To-the-point (aturan user 2026-11-28): putaran perbaikan kedua
    // jarang memperbaiki apa pun tapi selalu menambah 10-40 detik.
    const { events, result } = await run([
      withCalls(
        planCall("t0"),
        call("t1", "write_file", { path: "a.txt", content: "TODO: isi\n" }),
      ),
      finalText("Selesai."),
      withCalls(
        call("t2", "write_file", { path: "a.txt", content: "TODO: tetap\n" }),
      ),
      finalText("Sudah diperbaiki."),
    ]);
    expect(result.status).toBe("completed");
    const v = ofType(events, "verification");
    expect(v.map((e) => e.outcome)).toEqual(["fail", "fail"]);
    expect(v[1].fixes).toBe(1);
    expect(result.summary).toContain("1 putaran perbaikan");
  });

  it("plan mode allow: approval first, then the file is written", async () => {
    const { workspace, events, result } = await run(
      [
        withCalls(
          planCall("t0"),
          call("t1", "request_plan_approval", {
            summary: "Buat a.txt",
            files: ["a.txt"],
          }),
          call("t2", "write_file", { path: "a.txt", content: "ok\n" }),
        ),
        finalText("Selesai."),
      ],
      { approve: async () => true },
    );
    expect(result.status).toBe("completed");
    expect(ofType(events, "approval_resolved")[0].decision).toBe("allow");
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("ok\n");
  });

  it("plan mode deny: run stops and no file is written", async () => {
    const { workspace, events, result } = await run(
      [
        withCalls(
          planCall("t0"),
          call("t1", "request_plan_approval", {
            summary: "Buat a.txt",
            files: ["a.txt"],
          }),
          call("t2", "write_file", { path: "a.txt", content: "ok\n" }),
        ),
        finalText("tidak akan sampai sini"),
      ],
      { approve: async () => false },
    );
    expect(result.status).toBe("stopped");
    expect(ofType(events, "approval_resolved")[0].decision).toBe("deny");
    await expect(
      import("node:fs/promises").then((fs) =>
        fs.readFile(join(workspace, "a.txt"), "utf8"),
      ),
    ).rejects.toThrow();
    expect(ofType(events, "run_finished")[0].status).toBe("stopped");
  });
});

describe("vision usage aggregation", () => {
  it("adds inspect_image tokens to totals and emits a second usage event", async () => {
    const workspace = await tempWorkspace();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(join(workspace, "shot.png"), png);
    const events: AgentEvent[] = [];
    const emit = createEmitter("run_test", (e) => events.push(e));
    const result = await runAgent({
      llm: scripted([
        withCalls(
          planCall("t0"),
          call("t1", "inspect_image", { path: "shot.png" }),
        ),
        finalText("Gambar dilihat."),
      ]),
      model: "test-model",
      systemPrompt: "sys",
      message: "lihat gambar",
      sessionId: "s_test",
      workspace,
      limits: { maxCostUsd: 1 },
      prices: { inPerM: 1, outPerM: 2 },
      emit,
      approve: async () => false,
      describeImage: async () => ({
        text: "FAKE: tombol biru",
        model: "fake-vision",
        usage: { input_tokens: 50, output_tokens: 10, cached_tokens: 0 },
      }),
    });
    expect(result.status).toBe("completed");
    // chat usage 100/20 (turn 1) + vision 50/10 + chat 100/20 (final turn)
    expect(result.totals.input_tokens).toBe(250);
    expect(result.totals.output_tokens).toBe(50);
    // 2 chat usage events + 1 vision usage event
    expect(ofType(events, "usage")).toHaveLength(3);
    expect(ofType(events, "usage")[1].input_tokens).toBe(50);
    expect(ofType(events, "tool_call_finished")[1].ok).toBe(true);
  });
});

describe("git + mcp_call through the loop", () => {
  it("git commit is recorded", async () => {
    const workspace = await tempWorkspace();
    const git = (args: string[]) =>
      new Promise<void>((resolve, reject) => {
        execFile("git", args, { cwd: workspace }, (err) =>
          err ? reject(err) : resolve(),
        );
      });
    await git(["init", "-q"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test"]);
    const events: AgentEvent[] = [];
    const emit = createEmitter("run_test", (e) => events.push(e));
    const result = await runAgent({
      llm: scripted([
        withCalls(
          planCall("t0"),
          call("t1", "write_file", { path: "a.txt", content: "hi\n" }),
        ),
        withCalls(call("t2", "git", { op: "commit", message: "tambah a.txt" })),
        finalText("Commit selesai."),
      ]),
      model: "test-model",
      systemPrompt: "sys",
      message: "commit",
      sessionId: "s_test",
      workspace,
      limits: { maxCostUsd: 1 },
      prices: { inPerM: 1, outPerM: 2 },
      emit,
      approve: async () => false,
    });
    expect(result.status).toBe("completed");
    const log = await new Promise<string>((resolve, reject) => {
      execFile("git", ["-C", workspace, "log", "--oneline"], (err, stdout) =>
        err ? reject(err) : resolve(stdout),
      );
    });
    expect(log).toContain("tambah a.txt");
  });

  it("mcp_call reaches the echo server", async () => {
    const root = process.cwd();
    const echoServer = join(root, "scripts", "mcp-echo-server.ts");
    const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
    const prev = process.env.BIKININ_MCP_SERVERS;
    process.env.BIKININ_MCP_SERVERS = JSON.stringify([
      {
        name: "echo",
        command: process.execPath,
        args: [tsxCli, echoServer],
      },
    ]);
    try {
      const { events, result } = await run([
        withCalls(
          planCall("t0"),
          call("t1", "mcp_call", {
            server: "echo",
            tool: "echo",
            arguments: { text: "halo fase6" },
          }),
        ),
        finalText("MCP selesai."),
      ]);
      expect(result.status).toBe("completed");
      const finished = ofType(events, "tool_call_finished");
      expect(finished[1].ok).toBe(true);
      expect(finished[1].output_preview).toContain("halo fase6");
    } finally {
      if (prev === undefined) delete process.env.BIKININ_MCP_SERVERS;
      else process.env.BIKININ_MCP_SERVERS = prev;
    }
  });
});
