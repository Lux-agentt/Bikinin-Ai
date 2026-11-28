// Subagent runner (Fase 5, ala Claude Code Task): runs a focused sub-run
// with its own step/cost budget and read-only tools, then returns a compact
// summary to the main agent.
//
// Quota-aware by design: every subagent call burns the SAME provider quota
// as the main run (OpenRouter gratis: 50 request/hari per akun), so the
// main agent is told to delegate only when parallel research genuinely
// helps. At most MAX_CONCURRENT_SUBAGENTS run at once; extra calls fail
// fast with "sibuk" instead of queueing (to the point: never wait silently).
import { createEmitter } from "../events.js";
import type { AgentDeps, AgentResult, EmitFn } from "./loop.js";
import type { LlmClient } from "../llm/client.js";
import type { Prices } from "../llm/pricing.js";
import { getTool } from "../tools/registry.js";
import type { RegisteredTool } from "../tools/types.js";

export const SUBAGENT_MAX_STEPS = 8;
export const SUBAGENT_MAX_COST_USD = 0.05;
export const SUBAGENT_SUMMARY_MAX_CHARS = 2000;
export const MAX_CONCURRENT_SUBAGENTS = 2;
export const QUOTA_NOTE =
  "Subagent memakai kuota provider yang sama dengan run utama (OpenRouter gratis: 50 request/hari per akun).";

/** Tools a subagent may use: read-only, and never `delegate` (no nesting). */
export const SUBAGENT_TOOLS: RegisteredTool[] = [
  "list_dir",
  "read_file",
  "read_skill",
  "web_search",
].map((name) => {
  const t = getTool(name);
  if (!t) throw new Error(`tool subagent tidak ada: ${name}`);
  return t;
});

export interface DelegateResult {
  summary: string;
  status: AgentResult["status"];
  steps: number;
  costUsd: number;
  usage: { input_tokens: number; output_tokens: number; cached_tokens: number };
}

export type DelegateFn = (
  task: string,
  context?: string,
) => Promise<DelegateResult>;

export interface DelegateRunnerDeps {
  llm: LlmClient;
  model: string;
  prices: Prices;
  workspace: string;
  signal?: AbortSignal;
  /** The main run's emitter (subagent_started/finished go through it). */
  emit: EmitFn;
  /** The main run's runAgent, passed in to avoid a circular import. */
  runAgentImpl: (d: AgentDeps) => Promise<AgentResult>;
  /** Charge the sub-run's steps/cost/tokens to the main run's budget. */
  charge: (r: DelegateResult) => void;
}

let activeSubagents = 0;

const SUBAGENT_SYSTEM_PROMPT = `Kamu subagent riset luxagent. Tugasmu SATU hal spesifik dari agent utama; kerjakan dengan tool baca saja (list_dir, read_file, read_skill, web_search) dan jawab RINGKAS (maks ~1500 karakter): temuan + file/sumber yang relevan. Jangan menulis atau mengubah file apa pun, jangan memanggil tool lain, jangan bertele-tele. Kalau tidak menemukan jawabannya, katakan terus terang.`;

export function createDelegateRunner(d: DelegateRunnerDeps): DelegateFn {
  return async (task, context) => {
    if (activeSubagents >= MAX_CONCURRENT_SUBAGENTS) {
      return {
        summary:
          `Subagent sibuk (${MAX_CONCURRENT_SUBAGENTS} sedang berjalan). ` +
          "Kerjakan tugas ini langsung, atau coba lagi nanti.",
        status: "error",
        steps: 0,
        costUsd: 0,
        usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 },
      };
    }
    activeSubagents += 1;
    d.emit("subagent_started", {
      task: task.slice(0, 200),
      max_steps: SUBAGENT_MAX_STEPS,
      max_cost_usd: SUBAGENT_MAX_COST_USD,
      quota_note: QUOTA_NOTE,
    });
    try {
      const message = context
        ? `Tugas: ${task}\n\nKonteks dari agent utama:\n${context.slice(0, 2000)}`
        : task;
      const subRunId = `sub_${Date.now().toString(36)}`;
      const result = await d.runAgentImpl({
        llm: d.llm,
        model: d.model,
        systemPrompt: SUBAGENT_SYSTEM_PROMPT,
        message,
        sessionId: subRunId,
        workspace: d.workspace,
        limits: {
          maxSteps: SUBAGENT_MAX_STEPS,
          maxCostUsd: SUBAGENT_MAX_COST_USD,
        },
        prices: d.prices,
        // Subagent events are validated but not forwarded to the main
        // stream: only its compact summary returns to the main agent.
        // Its steps/cost are charged to the main budget below, so the
        // run totals stay honest.
        emit: createEmitter(subRunId, () => {}),
        approve: async () => false,
        signal: d.signal,
        tools: SUBAGENT_TOOLS,
        isSubagent: true,
      });
      const summary =
        result.summary.length > SUBAGENT_SUMMARY_MAX_CHARS
          ? `${result.summary.slice(0, SUBAGENT_SUMMARY_MAX_CHARS)}…[ringkasan subagent dipotong]`
          : result.summary;
      const out: DelegateResult = {
        summary,
        status: result.status,
        steps: result.totals.steps,
        costUsd: result.totals.cost_usd,
        usage: {
          input_tokens: result.totals.input_tokens,
          output_tokens: result.totals.output_tokens,
          cached_tokens: result.totals.cached_tokens,
        },
      };
      d.charge(out);
      d.emit("subagent_finished", {
        task: task.slice(0, 200),
        status: result.status,
        summary: summary.slice(0, 500),
        steps: out.steps,
        cost_usd: out.costUsd,
      });
      return out;
    } finally {
      activeSubagents -= 1;
    }
  };
}

/** Test hook: how many subagents are running right now. */
export function activeSubagentCount(): number {
  return activeSubagents;
}
