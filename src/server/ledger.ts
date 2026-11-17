// Per-run cost/time ledger (Fase 7, Track B).
//
// Built ONLY from events that already exist (run_started, usage,
// tool_call_finished, run_finished) — this module never changes the event
// contract and never makes LLM calls. Cost is the sum of usage.cost_usd,
// which the loop/fallback already computed from each call's provider
// inPerM/outPerM (see src/llm/pricing.ts); it is never a provider cost
// field. One JSON file per session, atomically written, so a ledger
// survives a server restart and can be rebuilt from the .jsonl log when
// the file is missing (runs that predate the ledger).
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent } from "../events.js";
import { readSessionEvents } from "./event-log.js";
import { MEMORY_DIR, SESSIONS_DIR } from "./persistence.js";

export type LedgerStatus =
  | "running"
  | "completed"
  | "stopped"
  | "error"
  | "budget_exceeded";

export interface ToolCallStats {
  total: number;
  ok: number;
  failed: number;
  /** Sum of tool_call_finished.duration_ms for this tool. */
  duration_ms: number;
}

export interface RunLedger {
  run_id: string;
  session_id: string;
  /** First model seen in run_started; models lists every model the run used. */
  model: string;
  models: string[];
  started_at: string | null;
  finished_at: string | null;
  /** From run_finished.duration_ms when present; while running, wall time since start. */
  duration_ms: number | null;
  status: LedgerStatus;
  steps: number;
  /** Number of LLM calls (usage events). */
  llm_calls: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  /** Sum of usage.cost_usd (loop-computed from inPerM/outPerM). */
  cost_usd: number;
  tool_calls: {
    total: number;
    ok: number;
    failed: number;
    by_tool: Record<string, ToolCallStats>;
  };
}

export function ledgerFilePath(workspace: string, sessionId: string): string {
  return join(workspace, MEMORY_DIR, SESSIONS_DIR, `${sessionId}.ledger.json`);
}

/**
 * Reduces one run's events into its ledger. Events of other runs are
 * ignored, so callers may pass a whole session log. Returns null when no
 * run_started for `runId` is present (unknown run).
 */
export function buildLedgerFromEvents(
  events: AgentEvent[],
  runId: string,
): RunLedger | null {
  let started: Extract<AgentEvent, { type: "run_started" }> | null = null;
  let finished: Extract<AgentEvent, { type: "run_finished" }> | null = null;
  const models: string[] = [];
  let llmCalls = 0;
  let input = 0;
  let output = 0;
  let cached = 0;
  let cost = 0;
  let steps = 0;
  const byTool: Record<string, ToolCallStats> = {};
  let toolTotal = 0;
  let toolOk = 0;
  let toolFailed = 0;

  for (const e of events) {
    if (e.run_id !== runId) continue;
    switch (e.type) {
      case "run_started":
        started = e;
        if (!models.includes(e.model)) models.push(e.model);
        break;
      case "usage":
        llmCalls += 1;
        input += e.input_tokens;
        output += e.output_tokens;
        cached += e.cached_tokens;
        cost += e.cost_usd;
        steps = Math.max(steps, e.totals.steps);
        break;
      case "tool_call_finished": {
        // The tool name is not on the finished event; recover it from the
        // matching started event (same run, same call_id).
        const start = events.find(
          (s) =>
            s.run_id === runId &&
            s.type === "tool_call_started" &&
            s.call_id === e.call_id,
        );
        const tool =
          start && start.type === "tool_call_started" ? start.tool : "unknown";
        const st = (byTool[tool] ??= {
          total: 0,
          ok: 0,
          failed: 0,
          duration_ms: 0,
        });
        st.total += 1;
        st.duration_ms += e.duration_ms;
        if (e.ok) {
          st.ok += 1;
          toolOk += 1;
        } else {
          st.failed += 1;
          toolFailed += 1;
        }
        toolTotal += 1;
        break;
      }
      case "run_finished":
        finished = e;
        steps = Math.max(steps, e.totals.steps);
        break;
    }
  }

  if (!started) return null;
  const sessionId = started.session_id;
  const startedAt = started.ts;
  const status: LedgerStatus = finished ? finished.status : "running";
  let durationMs: number | null = null;
  if (finished) {
    durationMs = finished.duration_ms;
  } else if (startedAt) {
    durationMs = Math.max(0, Date.now() - Date.parse(startedAt));
  }
  return {
    run_id: runId,
    session_id: sessionId,
    model: models[0] ?? started.model,
    models,
    started_at: startedAt,
    finished_at: finished ? finished.ts : null,
    duration_ms: durationMs,
    status,
    steps,
    llm_calls: llmCalls,
    input_tokens: input,
    output_tokens: output,
    cached_tokens: cached,
    cost_usd: cost,
    tool_calls: { total: toolTotal, ok: toolOk, failed: toolFailed, by_tool: byTool },
  };
}

/** Every run of a session, oldest first. Unknown run ids are skipped. */
export function buildSessionLedgers(events: AgentEvent[]): RunLedger[] {
  const runIds: string[] = [];
  for (const e of events) {
    if (e.type === "run_started" && !runIds.includes(e.run_id))
      runIds.push(e.run_id);
  }
  const out: RunLedger[] = [];
  for (const id of runIds) {
    const ledger = buildLedgerFromEvents(events, id);
    if (ledger) out.push(ledger);
  }
  out.sort((a, b) =>
    (a.started_at ?? "") < (b.started_at ?? "") ? -1 : 1,
  );
  return out;
}

/** All persisted ledgers of a session, oldest first. Missing/corrupt file means none. */
export async function loadLedger(
  workspace: string,
  sessionId: string,
): Promise<RunLedger[]> {
  let raw: string;
  try {
    raw = await readFile(ledgerFilePath(workspace, sessionId), "utf8");
  } catch {
    return [];
  }
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter(
      (d): d is RunLedger =>
        typeof d === "object" &&
        d !== null &&
        typeof (d as RunLedger).run_id === "string" &&
        typeof (d as RunLedger).session_id === "string",
    );
  } catch {
    return [];
  }
}

async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
}

/** Writes the whole session ledger file (atomic, so a crash never half-writes it). */
export async function saveLedger(
  workspace: string,
  sessionId: string,
  ledgers: RunLedger[],
): Promise<void> {
  await atomicWrite(
    ledgerFilePath(workspace, sessionId),
    JSON.stringify(ledgers, null, 2),
  );
}

/** Inserts or replaces one run's ledger, then persists. Returns the full list. */
export async function upsertLedger(
  workspace: string,
  sessionId: string,
  ledger: RunLedger,
): Promise<RunLedger[]> {
  const list = await loadLedger(workspace, sessionId);
  const i = list.findIndex((l) => l.run_id === ledger.run_id);
  if (i >= 0) list[i] = ledger;
  else list.push(ledger);
  list.sort((a, b) => ((a.started_at ?? "") < (b.started_at ?? "") ? -1 : 1));
  await saveLedger(workspace, sessionId, list);
  return list;
}

/**
 * Rebuilds a session's ledgers from its durable .jsonl event log. Used when
 * the ledger file is missing (e.g. runs that finished before the ledger
 * existed, or a deleted ledger file). Returns [] when there is no log.
 */
export async function ledgerFromSessionEvents(
  workspace: string,
  sessionId: string,
): Promise<RunLedger[]> {
  return buildSessionLedgers(
    await readSessionEvents(workspace, sessionId),
  );
}
