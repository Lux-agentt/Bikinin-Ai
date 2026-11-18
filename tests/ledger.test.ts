// Ledger (Fase 7, Track B): built from existing events, persisted per
// session, exposed over HTTP, and consistent with the .jsonl event log.
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { createEmitter, type AgentEvent } from "../src/events.js";
import type { ChatResult, LlmClient, ToolCallReq } from "../src/llm/client.js";
import { costUsd } from "../src/llm/pricing.js";
import { quotaFilePath, utcDay } from "../src/llm/quota.js";
import { createEventLog } from "../src/server/event-log.js";
import { createAppServer } from "../src/server/http.js";
import {
  buildLedgerFromEvents,
  buildSessionLedgers,
  ledgerFromSessionEvents,
  loadLedger,
  upsertLedger,
  type RunLedger,
} from "../src/server/ledger.js";
import { RunManager } from "../src/server/runs.js";

/** One finished run's events, collected through the real emitter. */
function fakeRunEvents(): AgentEvent[] {
  const events: AgentEvent[] = [];
  const emit = createEmitter("run_aaaaaaaa", (e) => events.push(e));
  emit("run_started", {
    session_id: "s_1234abcd",
    model: "test-model",
    effort: "sedang",
    user_message: "buat file",
    limits: { max_steps: 10, max_cost_usd: 1 },
  });
  emit("tool_call_started", {
    call_id: "c1",
    step: 1,
    tool: "write_file",
    label: "write_file index.html",
    args: { path: "index.html" },
  });
  emit("tool_call_finished", {
    call_id: "c1",
    ok: true,
    summary: "index.html ditulis",
    truncated: false,
    duration_ms: 120,
  });
  emit("usage", {
    step: 1,
    input_tokens: 100,
    output_tokens: 20,
    cached_tokens: 10,
    cost_usd: costUsd(
      { input_tokens: 100, output_tokens: 20 },
      { inPerM: 1, outPerM: 2 },
    ),
    totals: {
      steps: 1,
      input_tokens: 100,
      output_tokens: 20,
      cached_tokens: 10,
      cost_usd: costUsd(
        { input_tokens: 100, output_tokens: 20 },
        { inPerM: 1, outPerM: 2 },
      ),
    },
  });
  emit("tool_call_started", {
    call_id: "c2",
    step: 2,
    tool: "read_file",
    label: "read_file index.html",
    args: { path: "index.html" },
  });
  emit("tool_call_finished", {
    call_id: "c2",
    ok: false,
    summary: "gagal baca",
    truncated: false,
    duration_ms: 30,
  });
  emit("usage", {
    step: 2,
    input_tokens: 50,
    output_tokens: 10,
    cached_tokens: 0,
    cost_usd: costUsd(
      { input_tokens: 50, output_tokens: 10 },
      { inPerM: 1, outPerM: 2 },
    ),
    totals: {
      steps: 2,
      input_tokens: 150,
      output_tokens: 30,
      cached_tokens: 10,
      cost_usd:
        costUsd(
          { input_tokens: 100, output_tokens: 20 },
          { inPerM: 1, outPerM: 2 },
        ) +
        costUsd(
          { input_tokens: 50, output_tokens: 10 },
          { inPerM: 1, outPerM: 2 },
        ),
    },
  });
  emit("run_finished", {
    status: "completed",
    summary: "Selesai.",
    totals: {
      steps: 2,
      input_tokens: 150,
      output_tokens: 30,
      cached_tokens: 10,
      cost_usd:
        costUsd(
          { input_tokens: 100, output_tokens: 20 },
          { inPerM: 1, outPerM: 2 },
        ) +
        costUsd(
          { input_tokens: 50, output_tokens: 10 },
          { inPerM: 1, outPerM: 2 },
        ),
    },
    duration_ms: 1234,
    resumable: false,
  });
  return events;
}

describe("buildLedgerFromEvents", () => {
  it("sums tokens/cost, counts tool calls per tool, takes duration from run_finished", () => {
    const ledger = buildLedgerFromEvents(fakeRunEvents(), "run_aaaaaaaa");
    expect(ledger).not.toBeNull();
    const l = ledger as RunLedger;
    expect(l.run_id).toBe("run_aaaaaaaa");
    expect(l.session_id).toBe("s_1234abcd");
    expect(l.model).toBe("test-model");
    expect(l.models).toEqual(["test-model"]);
    expect(l.status).toBe("completed");
    expect(l.steps).toBe(2);
    expect(l.llm_calls).toBe(2);
    expect(l.input_tokens).toBe(150);
    expect(l.output_tokens).toBe(30);
    expect(l.cached_tokens).toBe(10);
    // Cost equals the loop's own recompute from inPerM/outPerM prices.
    expect(l.cost_usd).toBeCloseTo(
      costUsd(
        { input_tokens: 150, output_tokens: 30 },
        { inPerM: 1, outPerM: 2 },
      ),
      10,
    );
    expect(l.duration_ms).toBe(1234);
    expect(l.tool_calls.total).toBe(2);
    expect(l.tool_calls.ok).toBe(1);
    expect(l.tool_calls.failed).toBe(1);
    expect(l.tool_calls.by_tool.write_file).toEqual({
      total: 1,
      ok: 1,
      failed: 0,
      duration_ms: 120,
    });
    expect(l.tool_calls.by_tool.read_file).toEqual({
      total: 1,
      ok: 0,
      failed: 1,
      duration_ms: 30,
    });
  });

  it("reports a run without run_finished as running, and null for an unknown run", () => {
    const events = fakeRunEvents().filter((e) => e.type !== "run_finished");
    const l = buildLedgerFromEvents(events, "run_aaaaaaaa");
    expect(l?.status).toBe("running");
    expect(l?.finished_at).toBeNull();
    expect(l?.duration_ms).not.toBeNull();
    expect(buildLedgerFromEvents(events, "run_nope")).toBeNull();
  });

  it("ignores events of other runs in the same session log", () => {
    const events = fakeRunEvents();
    const other: AgentEvent[] = [];
    const emit = createEmitter("run_bbbbbbbb", (e) => other.push(e));
    emit("run_started", {
      session_id: "s_1234abcd",
      model: "other-model",
      effort: "sedang",
      user_message: "lain",
      limits: { max_steps: 10, max_cost_usd: 1 },
    });
    emit("usage", {
      step: 0,
      input_tokens: 999,
      output_tokens: 999,
      cached_tokens: 0,
      cost_usd: 9,
      totals: {
        steps: 0,
        input_tokens: 999,
        output_tokens: 999,
        cached_tokens: 0,
        cost_usd: 9,
      },
    });
    const ledgers = buildSessionLedgers([...events, ...other]);
    expect(ledgers).toHaveLength(2);
    expect(ledgers[0]?.input_tokens).toBe(150);
    expect(ledgers[1]?.model).toBe("other-model");
    expect(ledgers[1]?.status).toBe("running");
  });
});

describe("ledger persistence", () => {
  it("survives a reload: upsert then load returns the same numbers", async () => {
    const ws = await mkdtemp(join(tmpdir(), "bikinin-ledger-"));
    const ledger = buildLedgerFromEvents(
      fakeRunEvents(),
      "run_aaaaaaaa",
    ) as RunLedger;
    await upsertLedger(ws, "s_1234abcd", ledger);
    const loaded = await loadLedger(ws, "s_1234abcd");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(ledger);
    // Upserting the same run replaces it instead of duplicating.
    await upsertLedger(ws, "s_1234abcd", { ...ledger, status: "stopped" });
    expect(await loadLedger(ws, "s_1234abcd")).toHaveLength(1);
    expect((await loadLedger(ws, "s_1234abcd"))[0]?.status).toBe("stopped");
    // Missing session / corrupt file means no ledgers, never a crash.
    expect(await loadLedger(ws, "s_00000000")).toEqual([]);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(ws, ".bikinin", "sessions", "s_1234abcd.ledger.json"),
      "{bukan json",
      "utf8",
    );
    expect(await loadLedger(ws, "s_1234abcd")).toEqual([]);
  });

  it("rebuilds from the .jsonl event log when the ledger file is missing", async () => {
    const ws = await mkdtemp(join(tmpdir(), "bikinin-ledger-"));
    const log = createEventLog(ws, "s_1234abcd");
    for (const e of fakeRunEvents()) log.append(e);
    await log.flush();
    const rebuilt = await ledgerFromSessionEvents(ws, "s_1234abcd");
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]?.input_tokens).toBe(150);
    expect(rebuilt[0]?.cost_usd).toBeCloseTo(
      costUsd(
        { input_tokens: 150, output_tokens: 30 },
        { inPerM: 1, outPerM: 2 },
      ),
      10,
    );
    expect(rebuilt[0]?.tool_calls.total).toBe(2);
  });
});

describe("ledger quota snapshot (Fase 8)", () => {
  it("attaches today's :free snapshot when a counter file exists, and nothing when it does not", async () => {
    const ws = await mkdtemp(join(tmpdir(), "bikinin-ledger-"));
    const ledger = buildLedgerFromEvents(
      fakeRunEvents(),
      "run_aaaaaaaa",
    ) as RunLedger;
    // No :free request today: the persisted ledger is unchanged.
    await upsertLedger(ws, "s_1234abcd", ledger);
    expect((await loadLedger(ws, "s_1234abcd"))[0]?.quota).toBeUndefined();
    // With a counter file, the snapshot is attached on upsert.
    await mkdir(join(ws, ".bikinin", "quota"), { recursive: true });
    await writeFile(
      quotaFilePath(ws, utcDay()),
      JSON.stringify({
        version: 1,
        date: utcDay(),
        free: { used: 12, limit: 50 },
        by_model: { "test-model": 12 },
      }),
      "utf8",
    );
    await upsertLedger(ws, "s_1234abcd", ledger);
    expect((await loadLedger(ws, "s_1234abcd"))[0]?.quota).toEqual({
      date: utcDay(),
      free_used: 12,
      free_limit: 50,
    });
  });
});

// --- HTTP end-to-end: scripted run -> ledger endpoint -> restart ---

const usage = { input_tokens: 100, output_tokens: 20, cached_tokens: 0 };
const call = (id: string, name: string, args: unknown): ToolCallReq => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
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

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 15000) {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error("timeout menunggu kondisi");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("GET /api/sessions/:id/ledger", () => {
  it("matches usage + run_finished in the .jsonl log, and survives a manager restart", async () => {
    const { mkdtemp: mk, mkdir, realpath } = await import("node:fs/promises");
    const base = await mk(join(tmpdir(), "bikinin-ledger-srv-"));
    await mkdir(join(base, "ws"));
    const workspace = await realpath(join(base, "ws"));
    const responses: ChatResult[] = [
      {
        text: "",
        // Fase 5 plan-first: the first tool batch must include update_plan,
        // otherwise the loop nudges for a plan and skips the other calls.
        toolCalls: [
          call("c0", "update_plan", {
            items: [{ text: "Tulis index.html", status: "doing" }],
          }),
          call("c1", "write_file", {
            path: "index.html",
            content: "<h1>hi</h1>",
          }),
        ],
        usage,
      },
      { text: "Selesai.", toolCalls: [], usage },
    ];
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

    const started = await (
      await fetch(`${url}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "buat index.html" }),
      })
    ).json();
    const sessionId: string = started.session_id;
    await waitFor(async () => {
      const r = await fetch(`${url}/api/sessions/${sessionId}/ledger`);
      if (!r.ok) return false;
      const list = (await r.json()) as RunLedger[];
      return list.length === 1 && list[0]?.status === "completed";
    });
    const list = (await (
      await fetch(`${url}/api/sessions/${sessionId}/ledger`)
    ).json()) as RunLedger[];
    expect(list).toHaveLength(1);
    const l = list[0] as RunLedger;
    // Two LLM calls of 100 in / 20 out each.
    expect(l.llm_calls).toBe(2);
    expect(l.input_tokens).toBe(200);
    expect(l.output_tokens).toBe(40);
    expect(l.cost_usd).toBeCloseTo(
      costUsd(
        { input_tokens: 200, output_tokens: 40 },
        { inPerM: 1, outPerM: 2 },
      ),
      10,
    );
    expect(l.tool_calls.total).toBe(2);
    expect(l.tool_calls.by_tool.write_file?.total).toBe(1);
    expect(l.tool_calls.by_tool.update_plan?.total).toBe(1);
    expect(l.model).toBe("test-model");
    expect(l.steps).toBe(2);
    expect(l.duration_ms).not.toBeNull();

    // Cross-check against the durable .jsonl log (same source the UI replays).
    // The log drains in the background (fire-and-forget flush in runs.ts),
    // so wait until run_finished has actually landed on disk.
    await waitFor(async () => {
      try {
        const t = await readFile(
          join(workspace, ".bikinin", "sessions", `${sessionId}.jsonl`),
          "utf8",
        );
        return t.includes('"run_finished"');
      } catch {
        return false;
      }
    });
    const jsonl = await readFile(
      join(workspace, ".bikinin", "sessions", `${sessionId}.jsonl`),
      "utf8",
    );
    const logged = jsonl
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AgentEvent);
    const fin = logged.find((e) => e.type === "run_finished");
    expect(fin?.type).toBe("run_finished");
    if (fin?.type === "run_finished") {
      expect(l.input_tokens).toBe(fin.totals.input_tokens);
      expect(l.output_tokens).toBe(fin.totals.output_tokens);
      expect(l.cost_usd).toBeCloseTo(fin.totals.cost_usd, 10);
      expect(l.duration_ms).toBe(fin.duration_ms);
    }
    const usages = logged.filter((e) => e.type === "usage");
    expect(usages).toHaveLength(2);

    // Restart simulation: a fresh manager on the same workspace reads the
    // same ledger back from disk (no live run in memory).
    const manager2 = new RunManager(cfg, { workspace, systemPrompt: "sys" });
    await manager2.init();
    const afterRestart = await manager2.getLedger(sessionId);
    expect(afterRestart).toHaveLength(1);
    expect(afterRestart?.[0]).toEqual(l);
  });

  it("404 for an unknown session", async () => {
    const { mkdtemp: mk, mkdir, realpath } = await import("node:fs/promises");
    const base = await mk(join(tmpdir(), "bikinin-ledger-srv-"));
    await mkdir(join(base, "ws"));
    const workspace = await realpath(join(base, "ws"));
    const manager = new RunManager(cfg, { workspace, systemPrompt: "sys" });
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
    const r = await fetch(`${url}/api/sessions/s_00000000/ledger`);
    expect(r.status).toBe(404);
  });
});
