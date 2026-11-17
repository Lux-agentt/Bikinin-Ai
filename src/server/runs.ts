// Keeps runs in memory for the web UI: event buffer, live listeners, pending approvals, stop.
// One active run at a time, because all runs share one workspace.
import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  runAgent,
  type AgentDeps,
  type ApprovalRequest,
  type EmitFn,
} from "../agent/loop.js";
import type { Config } from "../config.js";
import type { z } from "zod";
import { createEmitter, StartRunBody, type AgentEvent } from "../events.js";
import type { LlmClient } from "../llm/client.js";
import { createFallbackLlm } from "../llm/fallback.js";
import type { ProviderConfig } from "../llm/providers.js";
import { MAX_SESSIONS, SessionHistory } from "../agent/history.js";

export interface RunRecord {
  runId: string;
  sessionId: string;
  events: AgentEvent[];
  finished: boolean;
  listeners: Set<(e: AgentEvent) => void>;
  abort: AbortController;
  pending: Map<string, (allow: boolean) => void>;
}

/** Lightweight metadata for the history panel. The title is the first prompt. */
interface SessionMeta {
  title: string;
  prompts: number;
  updatedAt: number;
  runIds: string[];
}

export interface SessionSummary {
  session_id: string;
  title: string;
  prompts: number;
  runs: number;
  updated_at: number;
  last_status: string | null;
}

export interface SessionDetail {
  session_id: string;
  title: string;
  prompts: number;
  updated_at: number;
  runs: Array<{ run_id: string; events: AgentEvent[] }>;
}

export interface RunManagerOptions {
  workspace: string; // absolute realpath
  systemPrompt: string;
  llm?: LlmClient; // tests inject a fake; production uses the provider list
}

export class BusyError extends Error {}

export class NotConfiguredError extends Error {}

export class RunManager {
  private readonly runs = new Map<string, RunRecord>();
  private activeRunId: string | null = null;
  private readonly sessions = new Map<string, SessionHistory>();
  private readonly meta = new Map<string, SessionMeta>();

  constructor(
    private readonly cfg: Config,
    private readonly opts: RunManagerOptions,
  ) {}

  /** Public, non-secret settings for the UI. Never includes keys or URLs. */
  info() {
    const primary = this.cfg.providers[0];
    return {
      model: primary?.model ?? "",
      models: [...new Set(this.cfg.providers.map((p) => p.model))],
      usd_idr: this.cfg.BIKININ_USD_IDR,
      max_steps: this.cfg.BIKININ_MAX_STEPS,
      max_cost_usd: this.cfg.BIKININ_MAX_COST_USD,
    };
  }

  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  /** Sessions for the history panel, newest first. */
  listSessions(): SessionSummary[] {
    return [...this.meta.entries()]
      .map(([id, m]) => {
        const lastRun =
          m.runIds.length > 0
            ? this.runs.get(m.runIds[m.runIds.length - 1])
            : undefined;
        let lastStatus: string | null = null;
        if (lastRun) {
          for (let i = lastRun.events.length - 1; i >= 0; i--) {
            const e = lastRun.events[i];
            if (e.type === "run_finished") {
              lastStatus = e.status;
              break;
            }
          }
        }
        return {
          session_id: id,
          title: m.title,
          prompts: m.prompts,
          runs: m.runIds.length,
          updated_at: m.updatedAt,
          last_status: lastStatus,
        };
      })
      .sort((a, b) => b.updated_at - a.updated_at);
  }

  /** One session with every run's events, for replay in the UI. */
  getSession(sessionId: string): SessionDetail | undefined {
    const m = this.meta.get(sessionId);
    if (!m) return undefined;
    return {
      session_id: sessionId,
      title: m.title,
      prompts: m.prompts,
      updated_at: m.updatedAt,
      runs: m.runIds.map((runId) => ({
        run_id: runId,
        events: this.runs.get(runId)?.events ?? [],
      })),
    };
  }

  /** Current workspace files (shared by all sessions), relative paths. */
  async listFiles(): Promise<Array<{ path: string; bytes: number }>> {
    const out: Array<{ path: string; bytes: number }> = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const abs = join(dir, e.name);
        if (e.isDirectory()) await walk(abs);
        else if (e.isFile()) {
          const st = await stat(abs);
          out.push({
            path: relative(this.opts.workspace, abs).split(sep).join("/"),
            bytes: st.size,
          });
        }
      }
    };
    await walk(this.opts.workspace);
    return out.sort((a, b) => a.path.localeCompare(b.path)).slice(0, 200);
  }

  start(body: z.infer<typeof StartRunBody>): {
    run_id: string;
    session_id: string;
  } {
    if (this.cfg.providers.length === 0)
      throw new NotConfiguredError(
        "LLM belum dikonfigurasi — isi LLM_BASE_URL, LLM_API_KEY, dan BIKININ_MODEL di .env, lalu restart server.",
      );
    if (this.activeRunId !== null)
      throw new BusyError("masih ada run yang berjalan");

    const runId = `run_${randomUUID().slice(0, 8)}`;
    // Only reuse a session id this server issued; anything else starts a new session.
    const sessionId =
      body.session_id && this.sessions.has(body.session_id)
        ? body.session_id
        : `s_${randomUUID().slice(0, 8)}`;
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, new SessionHistory());
      while (this.sessions.size > MAX_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest === undefined) break;
        this.sessions.delete(oldest);
        this.meta.delete(oldest);
      }
    }
    // Model must be on the server allowlist; anything else falls back to primary.
    const provider =
      this.cfg.providers.find((p) => p.model === body.model) ??
      this.cfg.providers[0];
    const effort = body.effort ?? "sedang";
    const m = this.meta.get(sessionId);
    if (m) {
      m.prompts += 1;
      m.updatedAt = Date.now();
      m.runIds.push(runId);
    } else {
      this.meta.set(sessionId, {
        title: body.message,
        prompts: 1,
        updatedAt: Date.now(),
        runIds: [runId],
      });
    }
    const rec: RunRecord = {
      runId,
      sessionId,
      events: [],
      finished: false,
      listeners: new Set(),
      abort: new AbortController(),
      pending: new Map(),
    };
    this.runs.set(runId, rec);
    this.activeRunId = runId;

    const emit: EmitFn = createEmitter(runId, (e) => {
      rec.events.push(e);
      if (e.type === "run_finished") rec.finished = true;
      for (const listener of rec.listeners) listener(e);
    });
    const approve = (req: ApprovalRequest) =>
      new Promise<boolean>((resolve) => {
        rec.pending.set(req.approvalId, resolve);
      });

    void this.execute(
      rec,
      body.message,
      emit,
      approve,
      provider,
      effort,
    ).finally(() => {
      for (const resolve of rec.pending.values()) resolve(false);
      rec.pending.clear();
      this.activeRunId = null;
    });

    return { run_id: runId, session_id: sessionId };
  }

  private async execute(
    rec: RunRecord,
    message: string,
    emit: EmitFn,
    approve: AgentDeps["approve"],
    provider: ProviderConfig,
    effort: "sedang" | "tinggi",
  ): Promise<void> {
    const history = this.sessions.get(rec.sessionId);
    try {
      const result = await runAgent({
        llm: this.opts.llm ?? createFallbackLlm(this.cfg.providers),
        model: provider.model,
        effort,
        systemPrompt: this.opts.systemPrompt,
        message,
        sessionId: rec.sessionId,
        workspace: this.opts.workspace,
        limits: {
          maxSteps: this.cfg.BIKININ_MAX_STEPS,
          maxCostUsd: this.cfg.BIKININ_MAX_COST_USD,
        },
        prices: { inPerM: provider.inPerM, outPerM: provider.outPerM },
        emit,
        approve,
        signal: rec.abort.signal,
        history: history?.messages(),
      });
      history?.add(result.transcript);
    } catch (err) {
      // runAgent normally always emits run_finished; this is a last-resort guard.
      if (!rec.finished) {
        emit("error", {
          code: "internal",
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        });
        emit("run_finished", {
          status: "error",
          summary: "Run berhenti karena error internal.",
          totals: {
            steps: 0,
            input_tokens: 0,
            output_tokens: 0,
            cached_tokens: 0,
            cost_usd: 0,
          },
          duration_ms: 0,
          resumable: false,
        });
      }
    }
  }

  stop(runId: string): boolean {
    const rec = this.runs.get(runId);
    if (!rec) return false;
    if (rec.finished) return true;
    rec.abort.abort();
    for (const resolve of rec.pending.values()) resolve(false);
    rec.pending.clear();
    return true;
  }

  approve(
    runId: string,
    approvalId: string,
    decision: "allow" | "deny",
  ): boolean {
    const rec = this.runs.get(runId);
    const resolve = rec?.pending.get(approvalId);
    if (!rec || !resolve) return false;
    rec.pending.delete(approvalId);
    resolve(decision === "allow");
    return true;
  }
}
