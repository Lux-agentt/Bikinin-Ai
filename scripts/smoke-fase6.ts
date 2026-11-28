// Smoke test Fase 6 (integrator): end-to-end dengan LLM scripted/dummy
// (model asli tidak tersedia di VM ini — live TIDAK diuji di sini).
//   (a) self-check menemukan kesalahan (npm test gagal) dan model memperbaikinya
//   (b) plan mode: allow menahan lalu menjalankan; deny berhenti tanpa file
//   (c) git commit tercatat
//   (d) mcp_call ke echo server kembali
//   (e) inspect_image lewat describeImage palsu + usage masuk total run
//   (f) pelajaran run sebelumnya — jalankan scripts/smoke-lessons.ts terpisah
// Usage: npx tsx scripts/smoke-fase6.ts
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent, type AgentDeps } from "../src/agent/loop.js";
import {
  createEmitter,
  type AgentEvent,
  type EventType,
} from "../src/events.js";
import type { ChatResult, LlmClient, ToolCallReq } from "../src/llm/client.js";

const usage = { input_tokens: 100, output_tokens: 20, cached_tokens: 0 };
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);

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
const planCall = (id: string) =>
  call(id, "update_plan", {
    items: [{ text: "Kerjakan tugas", status: "doing" }],
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
  overrides: Partial<AgentDeps> & { workspace: string },
) {
  const events: AgentEvent[] = [];
  const emit = createEmitter("run_smoke", (e) => events.push(e));
  const result = await runAgent({
    llm: scripted(responses),
    model: "test-model",
    systemPrompt: "sys",
    message: "smoke fase 6",
    sessionId: "s_smoke",
    limits: { maxCostUsd: 1 },
    prices: { inPerM: 1, outPerM: 2 },
    emit,
    approve: async () => false,
    ...overrides,
  });
  return { events, result };
}

function exec(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout}${stderr}` });
    });
  });
}

let pass = true;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`  ${ok ? "OK " : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) pass = false;
};

async function main(): Promise<void> {
  // --- (a) self-check: npm test gagal -> model memperbaiki -> lolos ---
  {
    console.log("(a) self-check menemukan dan memperbaiki kesalahan");
    const ws = await mkdtemp(join(tmpdir(), "bikinin-f6a-"));
    await writeFile(
      join(ws, "package.json"),
      JSON.stringify({
        name: "smoke",
        version: "1.0.0",
        scripts: { test: "node check.js" },
      }),
    );
    await writeFile(
      join(ws, "check.js"),
      `const fs = require("fs");\nprocess.exit(fs.readFileSync("app.txt", "utf8").includes("SALAH") ? 1 : 0);\n`,
    );
    const { events, result } = await run(
      [
        withCalls(
          planCall("t0"),
          call("t1", "write_file", { path: "app.txt", content: "SALAH\n" }),
        ),
        finalText("Selesai."),
        withCalls(
          call("t2", "write_file", { path: "app.txt", content: "BENAR\n" }),
        ),
        finalText("Sudah diperbaiki."),
      ],
      { workspace: ws },
    );
    const v = ofType(events, "verification");
    check("status completed", result.status === "completed", result.status);
    check(
      "verification fail lalu pass",
      v.map((e) => e.outcome).join(",") === "fail,pass",
      v.map((e) => e.outcome).join(","),
    );
    check(
      "perintah npm test tercatat gagal dulu",
      v[0]?.checks.some((c) => c.name === "perintah npm test" && !c.ok) ===
        true,
    );
    const { readFile } = await import("node:fs/promises");
    check(
      "file diperbaiki",
      (await readFile(join(ws, "app.txt"), "utf8")) === "BENAR\n",
    );
  }

  // --- (b) plan mode allow + deny ---
  {
    console.log("(b) plan mode allow");
    const ws = await mkdtemp(join(tmpdir(), "bikinin-f6b-"));
    const { events, result } = await run(
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
      { workspace: ws, approve: async () => true },
    );
    check("status completed", result.status === "completed", result.status);
    check(
      "approval allow",
      ofType(events, "approval_resolved")[0]?.decision === "allow",
    );
    const { readFile } = await import("node:fs/promises");
    check(
      "file dibuat setelah disetujui",
      (await readFile(join(ws, "a.txt"), "utf8")) === "ok\n",
    );
    check(
      "diff tercatat di file_changed",
      (ofType(events, "file_changed")[0]?.diff ?? "").includes("+ok"),
    );

    console.log("(b) plan mode deny");
    const ws2 = await mkdtemp(join(tmpdir(), "bikinin-f6b2-"));
    const denied = await run(
      [
        withCalls(
          planCall("t0"),
          call("t1", "request_plan_approval", {
            summary: "Buat a.txt",
            files: ["a.txt"],
          }),
          call("t2", "write_file", { path: "a.txt", content: "ok\n" }),
        ),
        finalText("tidak sampai sini"),
      ],
      { workspace: ws2, approve: async () => false },
    );
    check(
      "status stopped",
      denied.result.status === "stopped",
      denied.result.status,
    );
    check(
      "approval deny",
      ofType(denied.events, "approval_resolved")[0]?.decision === "deny",
    );
    const exists = await exec("test", ["-f", join(ws2, "a.txt")], ws2);
    check("file TIDAK dibuat", !exists.ok);
  }

  // --- (c) git commit tercatat ---
  {
    console.log("(c) git commit");
    const ws = await mkdtemp(join(tmpdir(), "bikinin-f6c-"));
    await exec("git", ["init", "-q"], ws);
    await exec("git", ["config", "user.email", "test@example.com"], ws);
    await exec("git", ["config", "user.name", "Test"], ws);
    const { result } = await run(
      [
        withCalls(
          planCall("t0"),
          call("t1", "write_file", { path: "a.txt", content: "hi\n" }),
        ),
        withCalls(call("t2", "git", { op: "commit", message: "tambah a.txt" })),
        finalText("Commit selesai."),
      ],
      { workspace: ws },
    );
    const log = await exec("git", ["-C", ws, "log", "--oneline"], ws);
    check("status completed", result.status === "completed", result.status);
    check("commit ada di log", log.out.includes("tambah a.txt"), log.out);
  }

  // --- (d) mcp_call ke echo server ---
  {
    console.log("(d) mcp_call echo server");
    const root = join(import.meta.dirname, "..");
    const prev = process.env.BIKININ_MCP_SERVERS;
    process.env.BIKININ_MCP_SERVERS = JSON.stringify([
      {
        name: "echo",
        command: process.execPath,
        args: [
          join(root, "node_modules", "tsx", "dist", "cli.mjs"),
          join(root, "scripts", "mcp-echo-server.ts"),
        ],
      },
    ]);
    try {
      const ws = await mkdtemp(join(tmpdir(), "bikinin-f6d-"));
      const { events, result } = await run(
        [
          withCalls(
            planCall("t0"),
            call("t1", "mcp_call", {
              server: "echo",
              tool: "echo",
              arguments: { text: "halo dari smoke fase6" },
            }),
          ),
          finalText("MCP selesai."),
        ],
        { workspace: ws },
      );
      check("status completed", result.status === "completed", result.status);
      check(
        "echo kembali",
        (
          ofType(events, "tool_call_finished")[1]?.output_preview ?? ""
        ).includes("halo dari smoke fase6"),
      );
    } finally {
      if (prev === undefined) delete process.env.BIKININ_MCP_SERVERS;
      else process.env.BIKININ_MCP_SERVERS = prev;
    }
  }

  // --- (e) inspect_image + usage vision ---
  {
    console.log("(e) inspect_image via describeImage palsu");
    const ws = await mkdtemp(join(tmpdir(), "bikinin-f6e-"));
    await writeFile(join(ws, "shot.png"), PNG_1X1);
    const { events, result } = await run(
      [
        withCalls(
          planCall("t0"),
          call("t1", "inspect_image", { path: "shot.png" }),
        ),
        finalText("Gambar dilihat."),
      ],
      {
        workspace: ws,
        describeImage: async () => ({
          text: "FAKE: screenshot aplikasi — ada tombol biru di bawah.",
          model: "fake-vision",
          usage: { input_tokens: 50, output_tokens: 10, cached_tokens: 0 },
        }),
      },
    );
    check("status completed", result.status === "completed", result.status);
    check(
      "output vision sampai ke model",
      (ofType(events, "tool_call_finished")[1]?.output_preview ?? "").includes(
        "FAKE:",
      ),
    );
    // chat 100/20 x2 turn + vision 50/10
    check(
      "usage vision diagregasi (in 250 / out 50)",
      result.totals.input_tokens === 250 && result.totals.output_tokens === 50,
      `in=${result.totals.input_tokens} out=${result.totals.output_tokens}`,
    );
  }

  console.log("");
  console.log(
    "(f) pelajaran run sebelumnya: jalankan scripts/smoke-lessons.ts",
  );
  console.log(pass ? "SMOKE FASE 6 PASS" : "SMOKE FASE 6 FAIL");
  if (!pass) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
