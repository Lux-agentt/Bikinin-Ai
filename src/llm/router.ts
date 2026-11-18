// Model router (Fase 7, Track C).
//
// Picks the FIRST provider for a run from the task text + run context, by
// reordering the configured provider list for that run only. The rest of the
// list keeps its original order, so the fallback chain in fallback.ts is
// unchanged as a set — it stays the safety net if the first model fails.
//
// Classification is deterministic and free: keyword heuristics over the
// user message only. It deliberately NEVER calls an LLM to classify —
// that would burn quota to decide how to spend quota.
//
// QUOTA: the OpenRouter :free limit is 50 requests/day PER ACCOUNT, shared
// by every :free model. Switching models does NOT add daily quota. That is
// why light tasks are routed to the fastest/cheapest model (they finish in
// one cheap call and never wake a heavy model) and why the router never
// retries or re-classifies mid-run: one routing decision per run, then the
// normal fallback chain takes over.
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderConfig } from "./providers.js";
import type { RouteInfo } from "../events.js";
import {
  freeDailyLimit,
  freeQuotaStatus,
  isFreeModel,
  isQuotaDisabled,
  resolveQuotaWorkspace,
  type FreeQuotaStatus,
} from "./quota.js";

export type RouteCategory = RouteInfo["category"];

export interface RouteOptions {
  /** False honours BIKININ_ROUTER=off: original config order, no routing. */
  enabled?: boolean;
  /** A model the user picked explicitly; always beats the router. */
  explicitModel?: string;
  /**
   * Measured outcomes to route from (Fase 8). When omitted, the store is
   * loaded from `workspace` (or the env workspace) best-effort; pass null
   * to force the heuristic with no store read.
   */
  stats?: RouterStats | null;
  /** Workspace holding .bikinin/router-stats.json and the quota counter. */
  workspace?: string;
}

export interface RouteResult {
  /** Providers reordered for this run: chosen model first, rest untouched. */
  providers: ProviderConfig[];
  /** What was decided and why; recorded on the run_started event. */
  route: RouteInfo;
}

/** BIKININ_ROUTER is ON by default; only off/false/0 turn it off. */
export function isRouterEnabled(value: string | undefined): boolean {
  if (value === undefined) return true;
  return !["off", "false", "0"].includes(value.trim().toLowerCase());
}

/* ---------- measured outcomes (Fase 8: data-driven routing) ---------- */

// The router used to be a static keyword heuristic. It now ALSO reads a
// small win table — per-model per-category outcomes recorded from finished
// live runs (via the ledger, src/server/ledger.ts) and from eval logs
// (importEvalReport). No extra LLM call is ever made for classification:
// the table is read from disk and the heuristic stays the fallback when
// there is not enough data.
//
// A model only wins on data when it has at least ROUTER_MIN_SAMPLES
// recorded outcomes in that category and a win rate of at least 50% —
// one lucky run must not flip routing. The heuristic pick wins all ties,
// so the data table refines routing instead of replacing its judgement.

export interface ModelOutcome {
  win: number;
  loss: number;
}

export interface RouterStats {
  version: 1;
  updated_at: string;
  outcomes: Partial<Record<RouteCategory, Record<string, ModelOutcome>>>;
  /**
   * Run ids / eval markers already counted. Re-persisting the same run
   * (ledger backfill, restart replay) never double-counts an outcome.
   */
  recorded: string[];
}

export const ROUTER_STATS_FILE = "router-stats.json";
export const ROUTER_MIN_SAMPLES = 3;
export const ROUTER_MIN_WIN_RATE = 0.5;
const ROUTER_MAX_RECORDED = 500;

export function routerStatsPath(workspace: string): string {
  return join(workspace, ".bikinin", ROUTER_STATS_FILE);
}

export function emptyRouterStats(): RouterStats {
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    outcomes: {},
    recorded: [],
  };
}

function parseRouterStats(data: unknown): RouterStats | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Partial<RouterStats>;
  if (d.version !== 1) return null;
  const outcomes: RouterStats["outcomes"] = {};
  if (typeof d.outcomes === "object" && d.outcomes !== null) {
    for (const [cat, table] of Object.entries(d.outcomes)) {
      if (!["coding", "reasoning", "light", "general"].includes(cat)) continue;
      if (typeof table !== "object" || table === null) continue;
      const clean: Record<string, ModelOutcome> = {};
      for (const [model, o] of Object.entries(table)) {
        if (
          typeof o === "object" &&
          o !== null &&
          typeof (o as ModelOutcome).win === "number" &&
          typeof (o as ModelOutcome).loss === "number" &&
          (o as ModelOutcome).win >= 0 &&
          (o as ModelOutcome).loss >= 0
        ) {
          clean[model] = {
            win: Math.floor((o as ModelOutcome).win),
            loss: Math.floor((o as ModelOutcome).loss),
          };
        }
      }
      outcomes[cat as RouteCategory] = clean;
    }
  }
  const recorded = Array.isArray(d.recorded)
    ? d.recorded.filter((k): k is string => typeof k === "string")
    : [];
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    outcomes,
    recorded,
  };
}

/** Sync load for the routing hot path; missing/corrupt means no data. */
export function loadRouterStatsSync(workspace: string): RouterStats | null {
  try {
    return parseRouterStats(
      JSON.parse(readFileSync(routerStatsPath(workspace), "utf8")) as unknown,
    );
  } catch {
    return null;
  }
}

async function loadRouterStats(workspace: string): Promise<RouterStats> {
  try {
    return (
      parseRouterStats(
        JSON.parse(
          await readFile(routerStatsPath(workspace), "utf8"),
        ) as unknown,
      ) ?? emptyRouterStats()
    );
  } catch {
    return emptyRouterStats();
  }
}

async function saveRouterStats(
  workspace: string,
  stats: RouterStats,
): Promise<void> {
  const path = routerStatsPath(workspace);
  await mkdir(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(stats, null, 2), "utf8");
  await rename(tmp, path);
}

export interface RouterOutcome {
  /** Dedup key (run id or eval marker). Outcomes without a key always count. */
  key?: string;
  model: string;
  category: RouteCategory;
  won: boolean;
}

function applyOutcome(stats: RouterStats, o: RouterOutcome): boolean {
  if (o.key) {
    if (stats.recorded.includes(o.key)) return false;
    stats.recorded.push(o.key);
    if (stats.recorded.length > ROUTER_MAX_RECORDED) {
      stats.recorded.splice(0, stats.recorded.length - ROUTER_MAX_RECORDED);
    }
  }
  const table = (stats.outcomes[o.category] ??= {});
  const cell = (table[o.model] ??= { win: 0, loss: 0 });
  if (o.won) cell.win += 1;
  else cell.loss += 1;
  return true;
}

/**
 * Records measured outcomes (live runs, eval imports). Best-effort by
 * design: a failure to persist stats must never break the ledger or a run.
 * Returns how many outcomes were actually recorded (0 when all were
 * duplicates or the write failed).
 */
export async function recordRouterOutcomes(
  workspace: string,
  outcomes: RouterOutcome[],
): Promise<number> {
  try {
    const stats = await loadRouterStats(workspace);
    let n = 0;
    for (const o of outcomes) {
      if (!o.model || !o.category) continue;
      if (applyOutcome(stats, o)) n += 1;
    }
    if (n === 0) return 0;
    stats.updated_at = new Date().toISOString();
    await saveRouterStats(workspace, stats);
    return n;
  } catch {
    return 0;
  }
}

/** Single-outcome convenience wrapper for the ledger hook. */
export async function recordRouterOutcome(
  workspace: string,
  outcome: RouterOutcome,
): Promise<boolean> {
  return (await recordRouterOutcomes(workspace, [outcome])) === 1;
}

/** Eval task categories do not match router categories 1:1; this is the mapping. */
export const EVAL_CATEGORY_MAP: Record<string, RouteCategory> = {
  bugfix: "coding",
  feature: "coding",
  fileops: "coding",
  edge: "coding",
  research: "reasoning",
  behavior: "general",
};

/** Eval logs label a model as "or-north (cohere/north-mini-code:free)"; the model is the part in parentheses. */
export function modelFromEvalLabel(label: string): string {
  const m = label.match(/\(([^)]+)\)/);
  return (m?.[1] ?? label).trim();
}

export interface EvalReportLike {
  model: string;
  startedAt?: string;
  results: Array<{
    id: string;
    category: string;
    status: "pass" | "fail" | "skip";
  }>;
}

/**
 * Imports one eval log (workspace/.bikinin/evals/<tanggal>.json) into the
 * win table. Skipped tasks are not outcomes; re-importing the same log is
 * a no-op per task (dedup key per task id). Returns outcomes recorded.
 * Not wired into scripts/eval.ts yet — call it after a live eval run.
 */
export async function importEvalReport(
  workspace: string,
  report: EvalReportLike,
): Promise<number> {
  const model = modelFromEvalLabel(report.model);
  if (!model) return 0;
  const marker = `eval:${report.startedAt ?? "tanpa-tanggal"}:${model}`;
  return recordRouterOutcomes(
    workspace,
    report.results
      .filter((r) => r.status !== "skip")
      .map((r) => ({
        key: `${marker}:${r.id}`,
        model,
        category: EVAL_CATEGORY_MAP[r.category] ?? "general",
        won: r.status === "pass",
      })),
  );
}

function winRate(o: ModelOutcome): number {
  const total = o.win + o.loss;
  return total === 0 ? 0 : o.win / total;
}

/**
 * Best measured model for a category, or null when no configured model has
 * enough data. Ties keep the heuristic pick (the caller passes it in as
 * the tie-breaker by checking it first — see routeProviders).
 */
export function pickFromStats(
  providers: ProviderConfig[],
  category: RouteCategory,
  stats: RouterStats,
): { model: ProviderConfig; win: number; loss: number } | null {
  const table = stats.outcomes[category];
  if (!table) return null;
  let best: { model: ProviderConfig; win: number; loss: number } | null = null;
  for (const p of providers) {
    const o = table[p.model];
    if (!o || o.win + o.loss < ROUTER_MIN_SAMPLES) continue;
    if (winRate(o) < ROUTER_MIN_WIN_RATE) continue;
    if (
      !best ||
      winRate(o) > winRate(best) ||
      (winRate(o) === winRate(best) && o.win + o.loss > best.win + best.loss)
    ) {
      best = { model: p, win: o.win, loss: o.loss };
    }
  }
  return best;
}

/* ---------- classification (deterministic, no LLM call) ---------- */

// Strong code signals: nouns / file extensions. Checked first.
const STRONG_CODING: RegExp[] = [
  /\bwebsite\b/,
  /\blanding\s?page\b/,
  /\baplikasi\b/,
  /\bhtml\b/,
  /\bcss\b/,
  /\bjavascript\b/,
  /\btypescript\b/,
  /\bpython\b/,
  /\breact\b/,
  /\bnext\.?js\b/,
  /\bnode\.?js\b/,
  /\bremotion\b/,
  /\bapi\b/,
  /\bendpoint\b/,
  /\bdatabase\b/,
  /\bkomponen\b/,
  /\bcomponent\b/,
  /\bfitur\b/,
  /\bhalaman\b/,
  /\btombol\b/,
  /\bform\b/,
  /\btampilan\b/,
  /\blayout\b/,
  /\bfungsi\b/,
  /\bfunction\b/,
  /\bbug\b/,
  /\berror\b/,
  /\bnpm\b/,
  /\bnpx\b/,
  /\bgit\b/,
  /\bdeploy\b/,
  /\bkode\b/,
  /\bcode\b/,
  /\bfrontend\b/,
  /\bbackend\b/,
  /\bfullstack\b/,
  /\.(html|css|js|ts|tsx|jsx|py|json|sql|md)\b/,
];

// Reasoning / orchestration signals. Checked before bare build verbs, so
// "buatkan rencana bisnis" routes to reasoning, not coding.
const REASONING: RegExp[] = [
  /\bbandingkan\b/,
  /\banalisis\b/,
  /\banalisa\b/,
  /\bevaluasi\b/,
  /\brekomendasi\b/,
  /\bstrategi\b/,
  /\barsitektur\b/,
  /\btrade-?off\b/,
  /\bris(e)?t\b/,
  /\bresearch\b/,
  /\bpenelitian\b/,
  /\bkelebihan\b/,
  /\bkekurangan\b/,
  /\bpro\s+dan\s+kontra\b/,
  /\bmengapa\b/,
  /\bkenapa\b/,
  /\brencana\b/,
  /\bdesain\s+sistem\b/,
  /\bpertimbangkan\b/,
  /\bkesimpulan\b/,
  /\bpilih\b.{0,30}\bterbaik\b/,
  /\bjelaskan\b.{0,30}\b(perbedaan|mengapa|kenapa)\b/,
];

// Bare build verbs: only a coding signal when no stronger signal matched.
const BUILD_VERBS: RegExp[] = [
  /\bbuatkan\b/,
  /\bbuat\b/,
  /\bbangun\b/,
  /\btulis\b/,
  /\btuliskan\b/,
  /\bperbaiki\b/,
  /\bfix\b/,
  /\bdebug\b/,
  /\brefaktor\b/,
  /\brefactor\b/,
  /\bimplementasikan\b/,
  /\bimplementasi\b/,
];

// Light tasks: greetings, thanks, and short simple questions.
const GREETING: RegExp =
  /^\s*(halo|hai|hi|hello|selamat\s+(pagi|siang|sore|malam)|pagi|siang|sore|malam|terima\s?kasih|makasih|thanks|tes|ping|ok|oke|sip|lanjutkan?|coba|ulangi|ya)\b/i;
const SIMPLE_QUESTION: RegExp[] = [
  /\bapa\b/,
  /\bsiapa\b/,
  /\bkapan\b/,
  /\bdi\s?mana\b/,
  /\bberapa\b/,
  /\bbagaimana\b/,
  /\bbisakah\b/,
  /\bapakah\b/,
  /\bjelaskan\b/,
  /\bsebutkan\b/,
  /\btampilkan\b/,
  /\btunjukkan\b/,
  /\bcari\b/,
  /\bcek\b/,
  /\blihat\b/,
  /\blist\b/,
  /\bdaftar\b/,
  /\bartinya\b/,
];

/** Short-message cutoff (characters, after trim) for simple questions. */
const SHORT_QUESTION_MAX = 140;

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[0].trim();
  }
  return null;
}

export function classifyTask(message: string): {
  category: RouteCategory;
  reason: string;
} {
  const text = message.toLowerCase().replace(/\s+/g, " ").trim();
  const coding = firstMatch(text, STRONG_CODING);
  if (coding)
    return {
      category: "coding",
      reason: `tugas coding (kata kunci: "${coding}")`,
    };
  const reasoning = firstMatch(text, REASONING);
  if (reasoning)
    return {
      category: "reasoning",
      reason: `tugas penalaran (kata kunci: "${reasoning}")`,
    };
  const verb = firstMatch(text, BUILD_VERBS);
  if (verb)
    return {
      category: "coding",
      reason: `tugas coding (kata kerja: "${verb}")`,
    };
  if (GREETING.test(text))
    return { category: "light", reason: "tugas ringan (sapaan/konfirmasi)" };
  if (text.length <= SHORT_QUESTION_MAX && firstMatch(text, SIMPLE_QUESTION))
    return {
      category: "light",
      reason: "tugas ringan (pertanyaan singkat)",
    };
  return {
    category: "general",
    reason: "tugas umum; urutan provider dari config dipertahankan",
  };
}

/* ---------- model preference per category ---------- */

/** Tries each pattern in order; first provider (in list order) that matches wins. */
function pickFirst(
  providers: ProviderConfig[],
  patterns: RegExp[],
): ProviderConfig | undefined {
  for (const re of patterns) {
    const hit = providers.find((p) => re.test(p.model) || re.test(p.name));
    if (hit) return hit;
  }
  return undefined;
}

function pickForCategory(
  providers: ProviderConfig[],
  category: RouteCategory,
): ProviderConfig {
  switch (category) {
    case "coding":
      // Prefer a model built for code (e.g. cohere/north-mini-code:free).
      return pickFirst(providers, [/code/i, /north/i]) ?? providers[0];
    case "reasoning":
      // Prefer the strongest model (e.g. nemotron-3.5-super-vl:free). When no
      // model advertises that, fall back to the priciest configured one:
      // price is a weak but free proxy for capability.
      return (
        pickFirst(providers, [
          /super/i,
          /reasoning|opus|large|70b|32b/i,
          /\bpro\b/i,
        ]) ??
        [...providers].sort(
          (a, b) => b.inPerM + b.outPerM - (a.inPerM + a.outPerM),
        )[0]
      );
    case "light": {
      // Prefer the fastest model (e.g. nemotron-3.5-lightning:free); when no
      // model advertises speed, take the cheapest — light tasks must never
      // wake an expensive model. Ties keep the original list order (stable
      // sort), so a free model is never skipped for a paid one on equal price.
      return (
        pickFirst(providers, [
          /lightning/i,
          /flash/i,
          /mini|lite|fast|haiku/i,
        ]) ??
        [...providers].sort(
          (a, b) => a.inPerM + a.outPerM - (b.inPerM + b.outPerM),
        )[0]
      );
    }
    case "general":
      return providers[0];
  }
}

function moveFirst<T>(list: T[], item: T): T[] {
  return [item, ...list.filter((x) => x !== item)];
}

/* ---------- entry point ---------- */

export function routeProviders(
  providers: ProviderConfig[],
  message: string,
  opts: RouteOptions = {},
): RouteResult {
  if (providers.length === 0) throw new Error("daftar provider kosong");

  const explicit = opts.explicitModel
    ? providers.find((p) => p.model === opts.explicitModel)
    : undefined;
  if (explicit) {
    const { category } = classifyTask(message);
    return {
      providers: moveFirst(providers, explicit),
      route: {
        category,
        reason: `model eksplisit "${explicit.model}" dipilih pengguna; router dilewati`,
        preferred_model: explicit.model,
      },
    };
  }

  if (opts.enabled === false) {
    return {
      providers: [...providers],
      route: {
        category: "general",
        reason:
          "router nonaktif (BIKININ_ROUTER=off); urutan provider dari config dipakai apa adanya",
        preferred_model: providers[0].model,
      },
    };
  }

  const { category, reason } = classifyTask(message);
  // Data-driven pick (Fase 8): the win table beats the heuristic only when
  // a model has enough measured outcomes in this category. The heuristic
  // pick wins ties, so thin data can never flip routing on its own.
  const stats =
    opts.stats !== undefined ? opts.stats : loadStatsForRoute(opts.workspace);
  const data = stats ? pickFromStats(providers, category, stats) : null;
  const heuristic = pickForCategory(providers, category);
  const picked = data?.model ?? heuristic;
  const dataReason = data
    ? `data router: ${data.model.model} menang ${data.win}/${data.win + data.loss} (${Math.round(winRate(data) * 100)}%) di kategori ${category} dari hasil terukur`
    : null;
  // Quota-aware skip (Fase 8): when the :free pool is empty for today, a
  // :free first pick would fail on its first call — start on the best
  // remaining provider instead. All :free models share one pool, so the
  // remaining set is exactly the non-free providers. When every provider
  // is :free and the pool is empty, the order is kept and the client stops
  // the run honestly on its first call.
  const quota = quotaStatusForRoute(opts.workspace);
  if (quota && quota.exhausted && isFreeModel(picked.model)) {
    const remaining = providers.filter((p) => !isFreeModel(p.model));
    if (remaining.length > 0) {
      const altData = stats ? pickFromStats(remaining, category, stats) : null;
      const alt = altData?.model ?? pickForCategory(remaining, category);
      return {
        providers: moveFirst(providers, alt),
        route: {
          category,
          reason: `kuota :free habis (${quota.used}/${quota.limit} request hari ini, UTC); pindah ke ${alt.model} — ${altData ? `data router: ${alt.model} menang ${altData.win}/${altData.win + altData.loss} di kategori ${category}` : reason}`,
          preferred_model: alt.model,
        },
      };
    }
  }
  return {
    providers: moveFirst(providers, picked),
    route: {
      category,
      reason: dataReason ?? reason,
      preferred_model: picked.model,
    },
  };
}

/**
 * Best-effort store load for routing: explicit workspace wins, otherwise
 * the env workspace (BIKININ_WORKSPACE, else the server default). Never
 * throws — routing must work with no data at all.
 */
function loadStatsForRoute(workspace?: string): RouterStats | null {
  try {
    return loadRouterStatsSync(workspace ?? resolveQuotaWorkspace(undefined));
  } catch {
    return null;
  }
}

/** Today's :free pool status, or null when quota is disabled/unreadable. */
function quotaStatusForRoute(workspace?: string): FreeQuotaStatus | null {
  try {
    if (isQuotaDisabled(process.env)) return null;
    return freeQuotaStatus(
      workspace ?? resolveQuotaWorkspace(undefined),
      freeDailyLimit(process.env),
    );
  } catch {
    return null;
  }
}
