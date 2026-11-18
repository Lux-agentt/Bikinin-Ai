// Daily LLM request quota (Fase 8).
//
// The OpenRouter :free pool is 50 requests/day PER ACCOUNT, shared by every
// :free model (switching models does NOT add quota) and by the main run +
// subagents. Until now it was only a warning string (QUOTA_NOTE); this
// module makes it enforced: a persistent per-UTC-day counter under
// workspace/.bikinin/quota/<YYYY-MM-DD>.json, counted at the LLM client
// layer (src/llm/client.ts) so main runs, subagents and vision calls all
// go through the same gate.
//
// Rules:
// - Only :free models (model id ends with ":free") are counted. Other
//   providers have no daily request cap in this design; their cost is
//   already tracked by the ledger.
// - The counter is checked BEFORE the HTTP request is sent and the request
//   is refused locally when the pool is empty, so an exhausted quota never
//   turns into a 429 loop: the client throws a fallback-eligible
//   AgentError and the fallback chain moves to the next provider, or the
//   run stops honestly when no provider has quota left.
// - Counting is conservative: a request is counted when it is attempted,
//   even if it then fails on the network. We would rather stop one request
//   early than burn the account into a real 429.
// - All file access here is synchronous on purpose: the client hot path is
//   sync, and within one Node process a sync read-modify-write cannot
//   interleave with another request. Two server processes sharing one
//   workspace could still race the counter (last write wins, off by a
//   request or two); that is a known limit, not a silent corruption — the
//   file always stays valid JSON.
// - The daily limit defaults to 50 and is configurable via
//   BIKININ_FREE_DAILY_LIMIT. BIKININ_QUOTA=off disables counting and
//   enforcement entirely.
import { homedir } from "node:os";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentError } from "../errors.js";

export const MEMORY_DIR_NAME = ".bikinin";
export const QUOTA_DIR_NAME = "quota";
export const FREE_POOL_KEY = "openrouter:free";
export const DEFAULT_FREE_DAILY_LIMIT = 50;

export type EnvLike = Record<string, string | undefined>;

/** One UTC day of :free usage. `free.limit` is the limit in force when written. */
export interface QuotaDayFile {
  version: 1;
  date: string; // UTC YYYY-MM-DD
  free: { used: number; limit: number };
  /** Requests per model id, for visibility (all share the one pool). */
  by_model: Record<string, number>;
}

export interface FreeQuotaStatus {
  date: string;
  used: number;
  limit: number;
  remaining: number;
  exhausted: boolean;
}

/** Snapshot attached to a finished run's ledger (and shown in the UI). */
export interface RunQuotaSnapshot {
  date: string;
  free_used: number;
  free_limit: number;
}

export interface QuotaClientOptions {
  workspace?: string;
  enabled?: boolean;
  dailyFreeLimit?: number;
}

/** UTC calendar day, YYYY-MM-DD. Quota days are UTC, never local time. */
export function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** True when the model id belongs to the shared :free pool. */
export function isFreeModel(model: string | undefined | null): boolean {
  return (
    typeof model === "string" && model.trim().toLowerCase().endsWith(":free")
  );
}

/** BIKININ_QUOTA=off (also false/0) disables counting and enforcement. */
export function isQuotaDisabled(env: EnvLike = process.env): boolean {
  return ["off", "false", "0"].includes(
    (env.BIKININ_QUOTA ?? "").trim().toLowerCase(),
  );
}

/** Daily :free limit: explicit override, else BIKININ_FREE_DAILY_LIMIT, else 50. */
export function freeDailyLimit(
  env: EnvLike = process.env,
  override?: number,
): number {
  if (override !== undefined && Number.isInteger(override) && override >= 0)
    return override;
  const raw = Number.parseInt(env.BIKININ_FREE_DAILY_LIMIT ?? "", 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_FREE_DAILY_LIMIT;
}

/**
 * Where quota (and router stats) live. Mirrors the server config default
 * (BIKININ_WORKSPACE, else ~/bikinin-workspace) so the client layer counts
 * against the same workspace the server runs in, without any wiring in
 * runs.ts / fallback.ts.
 */
export function resolveQuotaWorkspace(
  explicit?: string,
  env: EnvLike = process.env,
): string {
  return (
    explicit ?? env.BIKININ_WORKSPACE ?? join(homedir(), "bikinin-workspace")
  );
}

export function quotaFilePath(workspace: string, day: string): string {
  return join(workspace, MEMORY_DIR_NAME, QUOTA_DIR_NAME, `${day}.json`);
}

function emptyDay(date: string, limit: number): QuotaDayFile {
  return {
    version: 1,
    date,
    free: { used: 0, limit },
    by_model: {},
  };
}

function validDay(data: unknown, date: string, limit: number): QuotaDayFile {
  if (typeof data !== "object" || data === null) return emptyDay(date, limit);
  const d = data as Partial<QuotaDayFile>;
  const used =
    typeof d.free?.used === "number" && d.free.used >= 0
      ? Math.floor(d.free.used)
      : 0;
  const byModel: Record<string, number> = {};
  if (typeof d.by_model === "object" && d.by_model !== null) {
    for (const [k, v] of Object.entries(d.by_model)) {
      if (typeof v === "number" && v >= 0) byModel[k] = Math.floor(v);
    }
  }
  return { version: 1, date, free: { used, limit }, by_model: byModel };
}

/** Today's counter file; missing or corrupt means zero usage, never a crash. */
export function readQuotaDay(
  workspace: string,
  day: string = utcDay(),
  limit: number = DEFAULT_FREE_DAILY_LIMIT,
): QuotaDayFile {
  try {
    const raw = readFileSync(quotaFilePath(workspace, day), "utf8");
    return validDay(JSON.parse(raw) as unknown, day, limit);
  } catch {
    return emptyDay(day, limit);
  }
}

function writeQuotaDay(workspace: string, file: QuotaDayFile): void {
  const path = quotaFilePath(workspace, file.date);
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), "utf8");
  renameSync(tmp, path);
}

export function freeQuotaStatus(
  workspace: string,
  limit: number = DEFAULT_FREE_DAILY_LIMIT,
  day: string = utcDay(),
): FreeQuotaStatus {
  const file = readQuotaDay(workspace, day, limit);
  const used = file.free.used;
  return {
    date: day,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    exhausted: used >= limit,
  };
}

/**
 * Checks the :free pool and, when a request is still allowed, counts it.
 * Throws a fallback-eligible AgentError when the pool is empty — callers
 * must invoke this BEFORE sending the HTTP request, outside any retry
 * try/catch, so an exhausted quota is never retried or re-wrapped.
 * Non-free models are not counted and return an unexhausted status.
 */
export function checkAndRecordFreeRequest(
  workspace: string,
  model: string,
  limit: number = DEFAULT_FREE_DAILY_LIMIT,
  day: string = utcDay(),
): FreeQuotaStatus {
  if (!isFreeModel(model))
    return { date: day, used: 0, limit, remaining: limit, exhausted: false };
  const file = readQuotaDay(workspace, day, limit);
  if (file.free.used >= limit) {
    throw quotaExhaustedError({
      date: day,
      used: file.free.used,
      limit,
      remaining: 0,
      exhausted: true,
    });
  }
  file.free.used += 1;
  file.free.limit = limit;
  file.by_model[model] = (file.by_model[model] ?? 0) + 1;
  writeQuotaDay(workspace, file);
  return {
    date: day,
    used: file.free.used,
    limit,
    remaining: Math.max(0, limit - file.free.used),
    exhausted: file.free.used >= limit,
  };
}

/**
 * The honest-stop error: rate_limited (so the UI/logs say quota, not a
 * generic failure), not retryable against the same provider, but
 * fallback-eligible so the fallback chain tries the next provider.
 */
export function quotaExhaustedError(status: FreeQuotaStatus): AgentError {
  return new AgentError(
    "rate_limited",
    `Kuota harian OpenRouter :free habis (${status.used}/${status.limit} request, hari UTC ${status.date}). Tunggu sampai besok (UTC) atau jalankan dengan provider non-free.`,
    false,
    true,
  );
}

export interface ResolvedQuota {
  enabled: boolean;
  workspace: string;
  dailyFreeLimit: number;
}

/** Client-layer wiring: explicit opts win, env fills the rest. */
export function resolveQuotaClient(
  opts: QuotaClientOptions | undefined,
  env: EnvLike = process.env,
): ResolvedQuota {
  return {
    enabled: opts?.enabled ?? !isQuotaDisabled(env),
    workspace: resolveQuotaWorkspace(opts?.workspace, env),
    dailyFreeLimit: freeDailyLimit(env, opts?.dailyFreeLimit),
  };
}

/**
 * Today's :free snapshot for a run ledger / the UI. Null when no :free
 * request has been made today (no counter file), so ledgers from before
 * quota enforcement stay byte-identical.
 */
export async function readQuotaSnapshot(
  workspace: string,
  day: string = utcDay(),
): Promise<RunQuotaSnapshot | null> {
  let raw: string;
  try {
    raw = await readFile(quotaFilePath(workspace, day), "utf8");
  } catch {
    return null;
  }
  try {
    const file = validDay(
      JSON.parse(raw) as unknown,
      day,
      DEFAULT_FREE_DAILY_LIMIT,
    );
    return {
      date: day,
      free_used: file.free.used,
      free_limit: file.free.limit,
    };
  } catch {
    return null;
  }
}

/** True when a quota counter file exists (used by tests). */
export function quotaFileExists(
  workspace: string,
  day: string = utcDay(),
): boolean {
  return existsSync(quotaFilePath(workspace, day));
}
