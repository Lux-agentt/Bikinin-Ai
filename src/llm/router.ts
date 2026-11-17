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
import type { ProviderConfig } from "./providers.js";
import type { RouteInfo } from "../events.js";

export type RouteCategory = RouteInfo["category"];

export interface RouteOptions {
  /** False honours BIKININ_ROUTER=off: original config order, no routing. */
  enabled?: boolean;
  /** A model the user picked explicitly; always beats the router. */
  explicitModel?: string;
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
  if (
    text.length <= SHORT_QUESTION_MAX &&
    firstMatch(text, SIMPLE_QUESTION)
  )
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
    const hit = providers.find(
      (p) => re.test(p.model) || re.test(p.name),
    );
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
      return (
        pickFirst(providers, [/code/i, /north/i]) ?? providers[0]
      );
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
  const picked = pickForCategory(providers, category);
  return {
    providers: moveFirst(providers, picked),
    route: { category, reason, preferred_model: picked.model },
  };
}
