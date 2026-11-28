// Keeps runs in memory for the web UI: event buffer, live listeners, pending approvals, stop.
// One active run at a time, because all runs share one workspace.
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  runAgent,
  type AgentDeps,
  type AgentResult,
  type ApprovalRequest,
  type EmitFn,
} from "../agent/loop.js";
import {
  isAutoApproveEnabled,
  isLessonsModelExtractEnabled,
  isMemoryModelExtractEnabled,
  type Config,
} from "../config.js";
import type { z } from "zod";
import {
  createEmitter,
  StartRunBody,
  type AgentEvent,
  type EventType,
  type RouteInfo,
} from "../events.js";
import type { LlmClient } from "../llm/client.js";
import { createOpenAiLlm } from "../llm/client.js";
import { createFallbackLlm } from "../llm/fallback.js";
import { isRouterEnabled, routeProviders } from "../llm/router.js";
import { isSecretPath } from "../safety/paths.js";
import type { ProviderConfig } from "../llm/providers.js";
import {
  appendLessons,
  appendMemoryFacts,
  deleteSession as deletePersistedSession,
  loadSessions,
  pruneSessions,
  readLessonEntries,
  readMemoryEntries,
  saveSession,
  sessionsDirPath,
  type PersistedSession,
} from "./persistence.js";
import {
  createEventLog,
  readSessionEvents,
  type EventLog,
} from "./event-log.js";

/**
 * Pesan lanjutan yang ditempel ke prompt asli saat sebuah run dilanjutkan
 * (resume): tanpa ini model membaca riwayat + instruksi yang sama dan
 * sering mengulang pekerjaan dari awal — baca ulang file, tulis ulang
 * file yang sudah selesai. Aturan user 2026-11-28: kalau kerjaan berhenti,
 * lanjutkan dari yang sudah dikerjakan, jangan mulai dari awal.
 */
export const CONTINUE_SUFFIX =
  "\n\n[Lanjutkan run sebelumnya yang berhenti di tengah jalan — JANGAN mulai dari awal. Periksa dulu file di workspace dan riwayat di atas untuk melihat langkah mana yang sudah selesai, lalu lanjutkan dari titik berhentinya. Jangan tulis ulang file yang sudah selesai kecuali ada yang salah.]";
import {
  createCheckpoint,
  listCheckpoints,
  restoreCheckpoint as restoreCheckpointOnDisk,
} from "./checkpoints.js";
import {
  buildLedgerFromEvents,
  ledgerFilePath,
  ledgerFromSessionEvents,
  loadLedger,
  upsertLedger,
  type RunLedger,
} from "./ledger.js";
import { MAX_SESSIONS, SessionHistory } from "../agent/history.js";
import { rebuildHistory } from "../agent/replay.js";
import {
  buildLessonsContext,
  extractLessons,
  extractLessonsWithModel,
} from "../agent/lessons.js";
import {
  buildMemoryContext,
  extractFacts,
  extractImplicitPreferences,
  isFreeModel,
} from "../agent/memory.js";
import { extractiveSummary } from "../agent/summarize.js";

export interface RunRecord {
  runId: string;
  sessionId: string;
  events: AgentEvent[];
  finished: boolean;
  listeners: Set<(e: AgentEvent) => void>;
  abort: AbortController;
  pending: Map<string, (allow: boolean) => void>;
  /** On-disk NDJSON log for this run's session (Fase 1). */
  log: EventLog;
  /** Original prompt + provider, kept so a budget_exceeded run can resume. */
  message: string;
  provider: ProviderConfig;
  /** Provider order chosen for this run (router output); the fallback LLM
   *  tries them in this order. */
  providers: ProviderConfig[];
  effort: "sedang" | "tinggi";
}

/** Lightweight metadata for the history panel. The title is the first prompt.
 *  runIds only covers runs of this process (events are not persisted); runCount
 *  and lastStatus are the durable counters, restored from disk on startup. */
interface SessionMeta {
  title: string;
  prompts: number;
  updatedAt: number;
  runIds: string[];
  runCount: number;
  lastStatus: string | null;
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
  /**
   * Fase 8: rebuilds the system prompt with a FRESH skill list before each
   * run, so a skill folder added while the server runs appears in the next
   * run without a restart. Optional: when absent, the startup systemPrompt
   * is used as before. A builder failure falls back to the startup prompt —
   * a broken skills dir must never fail a run.
   */
  buildSystemPrompt?: () => Promise<string>;
  llm?: LlmClient; // tests inject a fake; production uses the provider list
}

export class BusyError extends Error {}

export class NotConfiguredError extends Error {}

/** An attachment_id that is missing, outside the workspace, or secret. */
export class BadAttachmentError extends Error {}

/** Batas run yang jalan bareng: satu per sesi, maks 5 sekaligus. VPS cuma
 *  1 vCPU — run kebanyakan nunggu LLM (jaringan), jadi 5 masih aman; lebih
 *  dari itu antrean client yang menahan (bukan server yang menolak diam-diam).
 *  (aturan user 2026-11-28: kerjaan harus paralel, minimal 5.) */
export const MAX_CONCURRENT_RUNS = 5;

export class RunManager {
  private readonly runs = new Map<string, RunRecord>();
  // Run yang sedang jalan, per sesi: beberapa run boleh jalan bareng
  // (satu per sesi, maks MAX_CONCURRENT_RUNS) — sebelumnya cuma satu run
  // global, jadi pindah chat berarti run lama harus selesai dulu.
  private readonly activeRunIds = new Set<string>();
  private readonly sessions = new Map<string, SessionHistory>();
  private readonly meta = new Map<string, SessionMeta>();

  constructor(
    private readonly cfg: Config,
    private readonly opts: RunManagerOptions,
  ) {}

  /**
   * Restores persisted sessions and their metadata from workspace/.bikinin/
   * (see persistence.ts). Call once at startup, before serving. Safe to call
   * on a fresh workspace (restores nothing) and safe to call twice.
   * Returns how many sessions were restored.
   */
  async init(): Promise<number> {
    let restored = 0;
    for (const s of await loadSessions(this.opts.workspace)) {
      if (this.sessions.has(s.session_id)) continue;
      this.sessions.set(s.session_id, SessionHistory.fromJSON(s.history));
      this.meta.set(s.session_id, {
        title: s.title,
        prompts: s.prompts,
        updatedAt: s.updated_at,
        runIds: [],
        runCount: s.runs,
        lastStatus: s.last_status,
      });
      restored++;
    }
    // Sessions whose .json snapshot is gone but whose .jsonl event log
    // survived (a run that never finished, or a crash before persist):
    // rebuild the snapshot from the log so the session comes back.
    restored += await this.recoverSessionsFromLogs();
    // Enforce the cap on disk too (a previous process may have left extras).
    await pruneSessions(this.opts.workspace, MAX_SESSIONS).catch(() => {});
    return restored;
  }

  /**
   * Rebuilds the .json snapshot of any session whose .jsonl event log
   * survived without one. Without this, such a session is invisible in
   * history even though its events — and its files — are still on disk.
   * Returns how many sessions were recovered.
   */
  private async recoverSessionsFromLogs(): Promise<number> {
    let names: string[];
    try {
      names = await readdir(sessionsDirPath(this.opts.workspace));
    } catch {
      return 0;
    }
    let recovered = 0;
    for (const name of names) {
      const m = /^(s_[a-f0-9]{8})\.jsonl$/.exec(name);
      if (!m) continue;
      const sessionId = m[1];
      if (this.sessions.has(sessionId)) continue;
      const events = await readSessionEvents(this.opts.workspace, sessionId);
      if (events.length === 0) continue;
      const runIds = [
        ...new Set(
          events
            .filter((e) => e.type === "run_started")
            .map((e) => e.run_id),
        ),
      ];
      if (runIds.length === 0) continue;
      const first = events.find((e) => e.type === "run_started");
      const lastFinished = [...events]
        .reverse()
        .find((e) => e.type === "run_finished");
      const lastTs = events[events.length - 1]?.ts;
      const parsed = lastTs ? Date.parse(lastTs) : Number.NaN;
      const history = rebuildHistory(events);
      const data: PersistedSession = {
        version: 1,
        session_id: sessionId,
        title:
          first && first.type === "run_started"
            ? first.user_message
            : sessionId,
        prompts: runIds.length,
        runs: runIds.length,
        last_status:
          lastFinished && lastFinished.type === "run_finished"
            ? lastFinished.status
            : null,
        updated_at: Number.isNaN(parsed) ? Date.now() : parsed,
        history: history.toJSON(),
      };
      try {
        await saveSession(this.opts.workspace, data);
      } catch {
        continue;
      }
      this.sessions.set(sessionId, SessionHistory.fromJSON(data.history));
      this.meta.set(sessionId, {
        title: data.title,
        prompts: data.prompts,
        updatedAt: data.updated_at,
        runIds,
        runCount: data.runs,
        lastStatus: data.last_status,
      });
      recovered++;
    }
    return recovered;
  }

  /** Public, non-secret settings for the UI. Never includes keys or URLs. */
  info() {
    const primary = this.cfg.providers[0];
    return {
      model: primary?.model ?? "",
      models: [...new Set(this.cfg.providers.map((p) => p.model))],
      providers: this.cfg.providers.map((p) => p.name),
      usd_idr: this.cfg.BIKININ_USD_IDR,
      max_cost_usd: this.cfg.BIKININ_MAX_COST_USD,
    };
  }

  /** Provider names + models for the eval tab and EvalManager (no keys/URLs). */
  listProviders(): Array<{ name: string; model: string }> {
    return this.cfg.providers.map((p) => ({ name: p.name, model: p.model }));
  }

  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  /** Sessions for the history panel, newest first. */
  listSessions(): SessionSummary[] {
    return [...this.meta.entries()]
      .map(([id, m]) => ({
        session_id: id,
        title: m.title,
        prompts: m.prompts,
        runs: m.runCount,
        updated_at: m.updatedAt,
        last_status: m.lastStatus,
      }))
      .sort((a, b) => b.updated_at - a.updated_at);
  }

  /** True bila sesi ini sudah punya run yang sedang jalan. */
  private sessionHasActiveRun(sessionId: string): boolean {
    for (const id of this.activeRunIds) {
      if (this.runs.get(id)?.sessionId === sessionId) return true;
    }
    return false;
  }

  /**
   * Deletes a session: memory (meta + finished run records), the
   * persisted .json + .jsonl log, and the ledger file. The shared
   * workspace files stay — only the chat transcript goes. Refuses when
   * a run of this session is still active; stop it first.
   */
  async deleteSession(
    sessionId: string,
  ): Promise<"ok" | "not-found" | "busy"> {
    const m = this.meta.get(sessionId);
    if (!m) return "not-found";
    if (this.sessionHasActiveRun(sessionId)) return "busy";
    for (const runId of m.runIds) {
      const rec = this.runs.get(runId);
      // The event log drains in the background: wait for pending appends
      // before removing the files, otherwise a late append recreates the
      // .jsonl after the delete.
      if (rec) await rec.log.flush().catch(() => {});
      this.runs.delete(runId);
    }
    this.sessions.delete(sessionId);
    this.meta.delete(sessionId);
    await deletePersistedSession(this.opts.workspace, sessionId);
    await rm(ledgerFilePath(this.opts.workspace, sessionId), {
      force: true,
    });
    return "ok";
  }

  /** One session with every run's events, for replay in the UI.
   *  In-memory events are the live source; after a restart they are gone,
   *  so runs are filled in from the durable .jsonl log (Fase 1, §8.1.2). */
  async getSession(sessionId: string): Promise<SessionDetail | undefined> {
    const m = this.meta.get(sessionId);
    if (!m) return undefined;
    const runs: Array<{ run_id: string; events: AgentEvent[] }> = m.runIds.map(
      (runId) => ({
        run_id: runId,
        events: this.runs.get(runId)?.events ?? [],
      }),
    );
    const logged = await readSessionEvents(this.opts.workspace, sessionId);
    const byRun = new Map<string, AgentEvent[]>();
    for (const e of logged) {
      const list = byRun.get(e.run_id) ?? [];
      list.push(e);
      byRun.set(e.run_id, list);
    }
    for (const [runId, events] of byRun) {
      const existing = runs.find((r) => r.run_id === runId);
      if (existing) {
        if (existing.events.length === 0) existing.events = events;
      } else {
        runs.push({ run_id: runId, events });
      }
    }
    runs.sort((a, b) => {
      const ta = a.events[0]?.ts ?? "";
      const tb = b.events[0]?.ts ?? "";
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    return {
      session_id: sessionId,
      title: m.title,
      prompts: m.prompts,
      updated_at: m.updatedAt,
      runs,
    };
  }

  /**
   * Per-run cost/time ledgers of a session, oldest first (Fase 7).
   * Persisted file first; when it is missing, the ledgers are rebuilt from
   * the durable .jsonl log and saved. Live (unfinished) runs are overlaid
   * from in-memory events so the UI sees numbers while a run is running.
   * undefined when the session does not exist.
   */
  async getLedger(sessionId: string): Promise<RunLedger[] | undefined> {
    if (!this.meta.get(sessionId)) return undefined;
    let ledgers = await loadLedger(this.opts.workspace, sessionId);
    if (ledgers.length === 0) {
      ledgers = await ledgerFromSessionEvents(this.opts.workspace, sessionId);
      if (ledgers.length > 0) {
        // Backfill so the next read is a plain file load.
        for (const l of ledgers) {
          await upsertLedger(this.opts.workspace, sessionId, l).catch(() => {});
        }
      }
    }
    const m = this.meta.get(sessionId);
    if (m) {
      for (const runId of m.runIds) {
        const rec = this.runs.get(runId);
        if (!rec || rec.events.length === 0) continue;
        const live = buildLedgerFromEvents(rec.events, runId);
        if (!live) continue;
        const i = ledgers.findIndex((l) => l.run_id === runId);
        if (i >= 0) ledgers[i] = live;
        else ledgers.push(live);
      }
      ledgers.sort((a, b) =>
        (a.started_at ?? "") < (b.started_at ?? "") ? -1 : 1,
      );
    }
    return ledgers;
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

    // Only reuse a session id this server issued; anything else starts a new session.
    const sessionId =
      body.session_id && this.sessions.has(body.session_id)
        ? body.session_id
        : `s_${randomUUID().slice(0, 8)}`;
    // Run bareng: satu sesi cuma boleh satu run aktif, dan total maks
    // MAX_CONCURRENT_RUNS. Sesi lain tetap boleh jalan — penolakan lama
    // ("masih ada run yang berjalan") berlaku global dan memaksa antre.
    if (this.sessionHasActiveRun(sessionId))
      throw new BusyError("sesi ini masih ada run yang berjalan");
    if (this.activeRunIds.size >= MAX_CONCURRENT_RUNS)
      throw new BusyError(
        `sudah ${MAX_CONCURRENT_RUNS} run berjalan bersamaan — tunggu satu selesai`,
      );
    // Model router (Fase 7): reorder providers for this run. An explicit
    // model (body.model) always beats the router; an unknown model name is
    // ignored and the router decides instead.
    const explicitModel =
      body.model && this.cfg.providers.some((p) => p.model === body.model)
        ? body.model
        : undefined;
    const { providers: ordered, route } = routeProviders(
      this.cfg.providers,
      body.message,
      {
        enabled: isRouterEnabled(this.cfg.BIKININ_ROUTER),
        explicitModel,
      },
    );
    const effort = body.effort ?? "sedang";
    // Attachments (POST /api/uploads): validate each id, then tell the
    // agent where the files are. The session title keeps the user's own
    // message; only the prompt the loop sees carries the file list.
    const attached = this.resolveAttachments(body.attachment_ids ?? []);
    const message =
      attached.length > 0
        ? `${body.message}\n\nFile terlampir (baca dengan read_file):\n${attached
            .map((a) => `- ${a.path} (${a.bytes} byte)`)
            .join("\n")}`
        : body.message;
    return this.beginRun(
      sessionId,
      message,
      ordered[0],
      effort,
      route,
      ordered,
      body.message,
    );
  }

  /**
   * Attachment ids are workspace-relative paths from POST /api/uploads.
   * Rejects anything missing, outside the workspace, or on a secret path —
   * the loop's read_file re-checks the same rules when it opens the file.
   */
  private resolveAttachments(
    ids: string[],
  ): Array<{ path: string; bytes: number }> {
    const out: Array<{ path: string; bytes: number }> = [];
    for (const id of ids) {
      if (isSecretPath(id))
        throw new BadAttachmentError(
          `lampiran ditolak (jalur rahasia): ${id}`,
        );
      const abs = resolve(this.opts.workspace, id);
      const rel = relative(this.opts.workspace, abs);
      if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel))
        throw new BadAttachmentError(
          `lampiran di luar workspace: ${id}`,
        );
      let size: number;
      try {
        const st = statSync(abs);
        if (!st.isFile())
          throw new BadAttachmentError(`lampiran bukan file: ${id}`);
        size = st.size;
      } catch (err) {
        if (err instanceof BadAttachmentError) throw err;
        throw new BadAttachmentError(`lampiran tidak ditemukan: ${id}`);
      }
      out.push({ path: rel.split(sep).join("/"), bytes: size });
    }
    return out;
  }

  /**
   * Continues a run that ended mid-work (budget_exceeded, stopped, or
   * error), with a fresh step/cost budget (§8.4). The session history
   * already holds the previous run's transcript, so the new run picks up
   * where the old one stopped — and the prompt carries CONTINUE_SUFFIX so
   * the model does not redo finished steps. A completed run is NOT
   * resumable (its work is done; starting over is a new task). The caller
   * maps the error to HTTP: not-found → 404, the rest → 409.
   */
  resume(
    runId: string,
  ):
    | { run_id: string; session_id: string }
    | { error: "not-found" | "busy" | "not-resumable" } {
    const old = this.runs.get(runId);
    if (!old) return { error: "not-found" };
    if (this.sessionHasActiveRun(old.sessionId)) return { error: "busy" };
    if (this.activeRunIds.size >= MAX_CONCURRENT_RUNS)
      return { error: "busy" };
    const last = old.events.at(-1);
    if (
      !old.finished ||
      last?.type !== "run_finished" ||
      !["budget_exceeded", "stopped", "error"].includes(last.status)
    )
      return { error: "not-resumable" };
    // Resume keeps the original run's provider and order: no re-routing
    // mid-session, so a resumed run never silently switches models. The
    // stored message stays the original prompt; the continuation note is
    // appended only if it is not already there (chained resumes must not
    // stack it).
    const message = old.message.includes(CONTINUE_SUFFIX)
      ? old.message
      : old.message + CONTINUE_SUFFIX;
    return this.beginRun(
      old.sessionId,
      message,
      old.provider,
      old.effort,
      undefined,
      old.providers,
    );
  }

  /** Creates the record, wires emit/approve, and starts the agent. */
  private beginRun(
    sessionId: string,
    message: string,
    provider: ProviderConfig,
    effort: "sedang" | "tinggi",
    route?: RouteInfo,
    providers: ProviderConfig[] = [provider],
    title: string = message,
  ): { run_id: string; session_id: string } {
    const runId = `run_${randomUUID().slice(0, 8)}`;
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, new SessionHistory());
      while (this.sessions.size > MAX_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest === undefined) break;
        this.sessions.delete(oldest);
        this.meta.delete(oldest);
        void deletePersistedSession(this.opts.workspace, oldest).catch(() => {});
      }
    }
    const m = this.meta.get(sessionId);
    if (m) {
      m.prompts += 1;
      m.updatedAt = Date.now();
      m.runIds.push(runId);
      m.runCount += 1;
    } else {
      this.meta.set(sessionId, {
        title,
        prompts: 1,
        updatedAt: Date.now(),
        runIds: [runId],
        runCount: 1,
        lastStatus: null,
      });
    }
    // Durability: persist the session as soon as the run starts. The .json
    // snapshot is what init() loads — a session whose run never finishes
    // would otherwise stay invisible in history even though its .jsonl log
    // exists. Fire-and-forget like the persist after run_finished.
    void this.persistSession(sessionId).catch(() => {});
    const rec: RunRecord = {
      runId,
      sessionId,
      events: [],
      finished: false,
      listeners: new Set(),
      abort: new AbortController(),
      pending: new Map(),
      log: createEventLog(this.opts.workspace, sessionId),
      message,
      provider,
      providers,
      effort,
    };
    this.runs.set(runId, rec);
    this.activeRunIds.add(runId);

    const emit: EmitFn = createEmitter(runId, (e) => {
      rec.events.push(e);
      // Fase 1: every event is also appended to the session .jsonl log,
      // so --continue and a later restart can replay the run.
      rec.log.append(e);
      if (e.type === "run_finished") {
        rec.finished = true;
        // Fase 7 ledger: persist the finished run's cost/time ledger
        // (built from the events above, no extra LLM call). Fire-and-
        // forget like persistSession: the run already finished.
        const ledger = buildLedgerFromEvents(rec.events, runId);
        if (ledger) {
          void upsertLedger(this.opts.workspace, sessionId, ledger).catch(
            () => {},
          );
        }
      }
      for (const listener of rec.listeners) listener(e);
    });
    const approve = (req: ApprovalRequest) =>
      new Promise<boolean>((resolve) => {
        rec.pending.set(req.approvalId, resolve);
      });

    // loop.ts owns the run_started event and this file must not edit it, so
    // the route is attached here instead: the wrapper adds `route` to
    // run_started only; every other event passes through untouched.
    const rawEmit = emit as unknown as (
      type: EventType,
      data: Record<string, unknown>,
    ) => AgentEvent;
    const emitForLoop: EmitFn = ((
      type: EventType,
      data: Record<string, unknown>,
    ) => {
      if (type === "run_started" && route)
        return rawEmit(type, { ...data, route });
      return rawEmit(type, data);
    }) as unknown as EmitFn;

    void this.execute(
      rec,
      message,
      emitForLoop,
      approve,
      provider,
      effort,
    ).finally(() => {
      for (const resolve of rec.pending.values()) resolve(false);
      rec.pending.clear();
      this.activeRunIds.delete(runId);
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
    // Fase 1: trim old history into a summary before the run, so the new
    // run's prompt fits the budget without silently losing old context.
    history?.summarizeOldest(extractiveSummary);
    // Long-term memory + recent sessions, injected into the system prompt so
    // the model sees what it learned in earlier sessions. A failed read
    // means no memory, never a failed run.
    const memoryBlock = await this.memoryContext(rec.sessionId, message).catch(
      () => "",
    );
    // Fase 6: episodic lessons relevant to this request, same treatment.
    const lessonsBlock = await this.lessonsContext(message).catch(() => "");
    // Fase 8: fresh skill list per run (hot reload). A new skills/ folder
    // added while the server runs is listed here, without a restart; a
    // broken skills dir falls back to the startup prompt, never a failed run.
    let basePrompt = this.opts.systemPrompt;
    if (this.opts.buildSystemPrompt) {
      basePrompt = await this.opts.buildSystemPrompt().catch(() => basePrompt);
    }
    const systemPrompt = [basePrompt, memoryBlock, lessonsBlock]
      .filter((b) => b.length > 0)
      .join("\n\n");
    // Fase 5: checkpoint workspace sebelum run dimulai (best-effort: gagal
    // membuat checkpoint tidak menggagalkan run; loop mencatatnya sebagai
    // event `checkpoint_created` atau `error` setelah `run_started`).
    let checkpoint: AgentDeps["checkpoint"];
    let checkpointError: string | undefined;
    try {
      const cp = await createCheckpoint(
        this.opts.workspace,
        rec.sessionId,
        rec.runId,
      );
      checkpoint = { id: cp.id, method: cp.method, files: cp.files.length };
    } catch (err) {
      checkpointError = err instanceof Error ? err.message : String(err);
    }
    try {
      // Fase 6: one LLM instance for the run — the same fallback client
      // also serves vision (inspect_image) through ToolContext.
      const llm = this.opts.llm ?? createFallbackLlm(rec.providers);
      const result = await runAgent({
        llm,
        model: provider.model,
        effort,
        systemPrompt,
        message,
        sessionId: rec.sessionId,
        workspace: this.opts.workspace,
        limits: {
          maxCostUsd: this.cfg.BIKININ_MAX_COST_USD,
        },
        // Auto-approve low/medium-risk approvals (owner rule, 28 Nov 2026):
        // BIKININ_AUTO_APPROVE=1 in .env. High-risk still asks; hard
        // blocks still block.
        autoApproveLowMedium: isAutoApproveEnabled(
          this.cfg.BIKININ_AUTO_APPROVE,
        ),
        prices: { inPerM: provider.inPerM, outPerM: provider.outPerM },
        emit,
        approve,
        signal: rec.abort.signal,
        history: history?.messages(),
        checkpoint,
        checkpointError,
        // Vision is optional: a test double without describeImage leaves
        // the tool to fail honestly ("vision belum tersedia").
        ...(llm.describeImage
          ? { describeImage: (req) => llm.describeImage!(req) }
          : {}),
      });
      history?.add(result.transcript);
      const m = this.meta.get(rec.sessionId);
      if (m) m.lastStatus = result.status;
      // The .jsonl log drains in the background (same trade-off as the
      // session .json below): awaiting it here would keep the run "busy"
      // after run_finished was already emitted, so the next POST would get
      // 409. The in-memory event buffer is the source of truth during the
      // run; the log is durability, and it catches up within milliseconds.
      void rec.log.flush().catch(() => {});
      // Durability: a crash or restart after this point must not lose the
      // session or what the run learned. Fire-and-forget on purpose: the
      // in-memory state above is already consistent, and awaiting disk IO
      // here would keep the run "busy" after run_finished was emitted.
      // Persistence failures are swallowed — the run already succeeded.
      // Trade-off, documented: the memory file may lag one run behind.
      void this.persistSession(rec.sessionId).catch(() => {});
      void this.updateMemory(result).catch(() => {});
      void this.updateLessons(result).catch(() => {});
    } catch (err) {
      // runAgent normally always emits run_finished; this is a last-resort guard.
      const m = this.meta.get(rec.sessionId);
      if (m) m.lastStatus = "error";
      void rec.log.flush().catch(() => {});
      void this.persistSession(rec.sessionId).catch(() => {});
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
          resumable: true,
        });
      }
    }
  }

  /** The memory block for the system prompt: long-term facts + recent sessions. */
  private async memoryContext(
    currentSessionId: string,
    query = "",
  ): Promise<string> {
    const entries = await readMemoryEntries(this.opts.workspace);
    const sessions = [...this.meta.entries()].map(([id, m]) => ({
      id,
      title: m.title,
      updatedAt: m.updatedAt,
    }));
    return buildMemoryContext(entries, sessions, currentSessionId, query);
  }

  /**
   * The lessons block for the system prompt: past failures whose keywords
   * overlap this request, so the model does not repeat them. Same
   * fail-soft treatment as memoryContext.
   */
  private async lessonsContext(query: string): Promise<string> {
    const lessons = await readLessonEntries(this.opts.workspace);
    return buildLessonsContext(lessons, query);
  }

  /** Writes one session's history + metadata to disk (atomic). */
  private async persistSession(sessionId: string): Promise<void> {
    const history = this.sessions.get(sessionId);
    const m = this.meta.get(sessionId);
    if (!history || !m) return;
    const data: PersistedSession = {
      version: 1,
      session_id: sessionId,
      title: m.title,
      prompts: m.prompts,
      runs: m.runCount,
      last_status: m.lastStatus,
      updated_at: m.updatedAt,
      history: history.toJSON(),
    };
    await saveSession(this.opts.workspace, data);
  }

  /**
   * Long-term memory update from a finished run. Rule-based extraction is
   * always on and costs nothing. Fase 8 adds an OPTIONAL model-assisted
   * pass for implicit preferences (flag BIKININ_MEMORY_MODEL_EXTRACT, off by
   * default): exactly one call, made DIRECTLY against the first `:free`
   * provider — never through the fallback chain, so it can never spill to a
   * paid model. Any failure is swallowed; memory stays rule-only.
   * Writes nothing when no durable fact was learned.
   */
  private async updateMemory(result: AgentResult): Promise<void> {
    const facts = extractFacts(
      result.transcript,
      result.summary,
      result.filesCreated,
      result.filesChanged,
      result.status,
    );
    if (isMemoryModelExtractEnabled(this.cfg.BIKININ_MEMORY_MODEL_EXTRACT)) {
      const free = this.cfg.providers.find((p) => isFreeModel(p.model));
      if (free) {
        const implicit = await extractImplicitPreferences(result.transcript, {
          enabled: true,
          freeModel: free.model,
          callFreeModel: async (prompt) =>
            (
              await createOpenAiLlm({
                baseURL: free.baseUrl,
                apiKey: free.apiKey,
              }).chat({
                model: free.model,
                messages: [{ role: "user", content: prompt }],
                tools: [],
              })
            ).text,
        }).catch(() => []);
        facts.push(...implicit);
      }
    }
    if (facts.length === 0) return;
    await appendMemoryFacts(this.opts.workspace, facts);
  }

  /**
   * Episodic lesson update from a finished run. Rule-based extraction is
   * always on and costs nothing. Auto-learn (28 Nov 2026, owner rule) adds
   * an OPTIONAL model-assisted pass (flag BIKININ_LESSONS_MODEL_EXTRACT,
   * on by default): exactly one call, made DIRECTLY against the first
   * `:free` provider — never through the fallback chain, so it can never
   * spill to a paid model. The model writes the lesson itself (root cause
   * + correct fix, with evidence) instead of the rule template "coba tool
   * lain". Any failure is swallowed; lessons stay rule-only.
   * Writes nothing when no durable lesson was learned.
   */
  private async updateLessons(result: AgentResult): Promise<void> {
    const lessons = extractLessons(
      result.transcript,
      result.summary,
      result.status,
    );
    if (isLessonsModelExtractEnabled(this.cfg.BIKININ_LESSONS_MODEL_EXTRACT)) {
      const free = this.cfg.providers.find((p) => isFreeModel(p.model));
      if (free) {
        const deep = await extractLessonsWithModel(
          result.transcript,
          result.summary,
          result.status,
          {
            enabled: true,
            freeModel: free.model,
            callFreeModel: async (prompt) =>
              (
                await createOpenAiLlm({
                  baseURL: free.baseUrl,
                  apiKey: free.apiKey,
                }).chat({
                  model: free.model,
                  messages: [{ role: "user", content: prompt }],
                  tools: [],
                })
              ).text,
          },
        ).catch(() => []);
        lessons.push(...deep);
      }
    }
    if (lessons.length === 0) return;
    await appendLessons(this.opts.workspace, lessons);
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

  /**
   * Fase 5: restore a checkpoint. Explicit user action only (the HTTP
   * route requires a POST from the UI). The restore is recorded as a
   * `checkpoint_restored` event in the checkpoint's session log.
   */
  async restoreCheckpoint(
    id: string,
  ): Promise<{
    checkpoint_id: string;
    files_restored: number;
    method: "git" | "copy";
  }> {
    const meta = (await listCheckpoints(this.opts.workspace)).find(
      (c) => c.id === id,
    );
    if (!meta) throw new Error(`checkpoint tidak ditemukan: ${id}`);
    const { files_restored, method } = await restoreCheckpointOnDisk(
      this.opts.workspace,
      id,
    );
    const log = createEventLog(this.opts.workspace, meta.session_id);
    const emit = createEmitter(`restore_${id.slice(0, 8)}`, (e) =>
      log.append(e),
    );
    emit("checkpoint_restored", {
      checkpoint_id: id,
      method,
      files_restored,
    });
    await log.flush();
    return { checkpoint_id: id, files_restored, method };
  }
}
