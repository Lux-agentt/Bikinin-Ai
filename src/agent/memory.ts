// Long-term memory: durable facts the agent learned across sessions.
// Pure logic (no filesystem here) so it is easy to test. Disk lives in
// src/server/persistence.ts. Design choice, documented:
// - Extraction is RULE-BASED and deterministic, never a model call. Only
//   explicit user-stated identity/preferences/decisions/rules and concrete
//   run outcomes (files created/changed) are recorded. Raw transcripts are
//   never stored here; session transcripts live in the per-session files.
// - Anything that looks like a secret is dropped before it can be written.
// - Injection is a small char-budgeted slice prepended to the system
//   prompt, ranked by keyword overlap with the current message + recency
//   (same pattern as lessons injection), so the model sees the relevant
//   past facts without blowing the token budget.
// - OPTIONAL model-assisted extraction (Fase 8) covers implicit
//   preferences the rules miss ("aku tuh paling males kalau ...",
//   "biasanya aku ..."). It is OFF by default (BIKININ_MEMORY_MODEL_EXTRACT),
//   runs at most ONE extra call per run, ONLY against a `:free` model via a
//   direct client (never the fallback chain, which could spill to a paid
//   model), and its output still passes the same secret filter. Any
//   failure (no free provider, quota/429, bad output) disables it silently
//   for that run — the rule-based path above always keeps working.
import type { ChatCompletionMessageParam as Msg } from "openai/resources/chat/completions";

export const MEMORY_INJECT_BUDGET = 6000; // chars injected into the system prompt
export const MEMORY_MAX_BYTES = 32 * 1024; // cap for the memory file on disk
export const MEMORY_ENTRY_MAX = 300; // chars per entry

export type MemoryKind = "fakta" | "preferensi" | "keputusan" | "hasil";

export interface MemoryEntry {
  date: string; // YYYY-MM-DD
  kind: MemoryKind;
  text: string;
}

export interface FreshFact {
  kind: MemoryKind;
  text: string;
}

// Anything that looks like a credential, token, or claim code. Checked
// against every candidate fact AND again before writing the file.
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{16,}/, // OpenAI-style keys
  /sk-ant-[A-Za-z0-9_-]{8,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /gho_[A-Za-z0-9]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{8,}/,
  // Any mention of a credential noun drops the sentence: it may carry the
  // value ("password saya adalah X", "API key saya ..."). Fail closed —
  // a dropped fact costs nothing, a leaked secret costs everything.
  /\b(api[_-]?key|apikey|api[_-]?token|access[_-]?token|auth[_-]?token|secret|password|passwd|kata[_-]?sandi|claim[ _-]?code|kode[_-]?klaim|private[_-]?key)\b/i,
  /bearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /-----BEGIN (.* )?PRIVATE KEY-----/,
  /\b[A-Za-z0-9_-]{40,}\b/, // long bare token (hex/base64/base64url)
  /\b[A-Za-z0-9]{32}\b/, // 32-char hex token (common key shape)
];

export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(text));
}

// One user sentence is a fact candidate when it states something durable.
// The whole message is never stored — only the matching sentence.
const RULES: Array<{ kind: MemoryKind; re: RegExp }> = [
  {
    kind: "fakta",
    re: /\b(namaku|nama saya|nama gue|panggil (aku|saya|gue)|aku dari|saya dari|tinggal di)\b/i,
  },
  {
    kind: "fakta",
    re: /\b(ingat|catat|tandai|simpen|simpan|jangan lupa)\b.*\b(bahwa|kalau|kalo)?/i,
  },
  {
    kind: "keputusan",
    re: /\b(keputusan|kita putuskan|diputuskan|memutuskan|sepakat|pilih|pilihan (kita|aku|saya))\b/i,
  },
  {
    kind: "preferensi",
    re: /\b(aku|saya|gue) (suka|lebih suka|tidak suka|nggak suka|ngga suka|mau|ingin|pengen)\b/i,
  },
  {
    kind: "preferensi",
    re: /\b(pakai|gunakan|pake)\b.*\b(saja|aja)\b/i,
  },
  {
    kind: "preferensi",
    re: /\b(jangan|tidak boleh|nggak boleh|ga boleh)\b/i,
  },
  {
    kind: "preferensi",
    re: /\b(selalu|tidak pernah|jangan pernah|setiap kali)\b/i,
  },
];

function sentences(text: string): string[] {
  return text
    .split(/[\n;]+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);
}

function cleanFact(kind: MemoryKind, text: string): FreshFact | null {
  const t = text.replace(/\s+/g, " ").trim().slice(0, MEMORY_ENTRY_MAX);
  if (t.length < 8) return null;
  if (containsSecret(t)) return null;
  return { kind, text: t };
}

/**
 * Deterministic extraction from one finished run. Reads user turns only
 * (assistant/tool turns are not user-stated facts), plus a one-line outcome
 * when the run created or changed files. Returns [] when nothing durable
 * was learned — the caller then writes nothing.
 */
export function extractFacts(
  transcript: Msg[],
  summary: string,
  filesCreated: string[],
  filesChanged: string[],
  status: string,
): FreshFact[] {
  const out: FreshFact[] = [];
  const seen = new Set<string>();
  const push = (f: FreshFact | null) => {
    if (!f) return;
    const key = `${f.kind}:${f.text.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  };

  for (const m of transcript) {
    if (m.role !== "user" || typeof m.content !== "string") continue;
    for (const s of sentences(m.content)) {
      if (containsSecret(s)) continue;
      for (const rule of RULES) {
        if (rule.re.test(s)) {
          push(cleanFact(rule.kind, s));
          break; // first matching rule wins per sentence
        }
      }
    }
  }

  if (status === "completed" && filesCreated.length + filesChanged.length > 0) {
    const files = [...filesCreated, ...filesChanged].slice(0, 5).join(", ");
    const firstLine = summary.split("\n")[0].trim().slice(0, 120);
    push(
      cleanFact(
        "hasil",
        firstLine
          ? `Membuat/mengubah ${files} — ${firstLine}`
          : `Membuat/mengubah ${files}`,
      ),
    );
  }
  return out;
}

/* ---------- optional model-assisted extraction (Fase 8) ---------- */

// Sentences that carry an implied preference or habit without stating it
// explicitly: no rule above matches them ("suka/mau/ingin/jangan" and
// friends are absent), but the phrasing still says something durable
// about the user. These are CANDIDATES for one model call — the model
// decides whether each one really is a preference; the rules never see
// them, so without this step they would be lost.
const IMPLICIT_PATTERNS: RegExp[] = [
  // "aku tuh paling males kalau loadingnya lama", "benci kalau ..."
  /\b(males|malas|benci|sebel|capek|pegal|ribet|pusing)\b.*\b(kalau|kalo|saat|ketika|pas)\b/i,
  // "biasanya aku ngoding jam 2 pagi", "biasanya kubuka ..."
  /\bbiasanya\b/i,
  // "aku tuh lebih suka yang simpel" is caught by the rules; "aku tuh ..."
  // without an explicit preference verb still implies one.
  /\b(aku|saya|gue)\s+tuh\b/i,
  // "lebih enak kalau ...", "mending pakai ...", "enakan yang ..."
  /\b(lebih\s+(enak|gampang|mudah|cepat|simpel)|enakan|mending)\b/i,
  // "nggak betah kalau ...", "tidak betah ..."
  /\b(nggak|ngga|tidak|tak|ga)\s+betah\b/i,
  // "kalau bisa jangan ...", "kalau bisa pakai ..." — a soft preference.
  /\b(kalau|kalo)\s+bisa\b/i,
  // "usahain ..." / "usahakan ..." — a standing instruction in disguise.
  /\b(usahain|usahakan)\b/i,
];

/**
 * User sentences that match NO extraction rule but DO match an
 * implicit-preference pattern. Deduplicated, secret-filtered, capped so
 * the model prompt stays small. Empty when the run said nothing
 * implicit — the caller then makes no model call at all.
 */
export function collectImplicitCandidates(transcript: Msg[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of transcript) {
    if (m.role !== "user" || typeof m.content !== "string") continue;
    for (const s of sentences(m.content)) {
      if (containsSecret(s)) continue;
      if (RULES.some((r) => r.re.test(s))) continue; // rules already got it
      if (!IMPLICIT_PATTERNS.some((p) => p.test(s))) continue;
      const t = s.replace(/\s+/g, " ").trim().slice(0, MEMORY_ENTRY_MAX);
      if (t.length < 8 || seen.has(t.toLowerCase())) continue;
      seen.add(t.toLowerCase());
      out.push(t);
      if (out.length >= 10) return out;
    }
  }
  return out;
}

/** True for OpenRouter free-tier model names ("...:free"). Paid models
 *  (Nano, Gemini, any name without the :free suffix) return false. */
export function isFreeModel(model: string): boolean {
  return model.includes(":free");
}

/** One chat call against a `:free` model. Implemented by the caller with a
 *  DIRECT client for that provider — never the fallback chain, which would
 *  spill over to a paid provider when the free one returns 429. */
export type FreeModelCall = (prompt: string) => Promise<string>;

export function buildImplicitExtractPrompt(candidates: string[]): string {
  return [
    "Dari kalimat-kalimat pengguna berikut, tuliskan preferensi atau kebiasaan tersiratnya — hal yang TIDAK dinyatakan eksplisit dengan kata suka/mau/ingin/jangan, tapi tersirat dari cara dia mengatakannya.",
    'Jawab HANYA dengan array JSON, tanpa penjelasan. Setiap item: {"kind": "preferensi", "text": "..."}.',
    "Tulis ulang dengan kata-kata pengguna sendiri, jangan menambah fakta baru. Abaikan kalimat yang bukan preferensi atau kebiasaan. Kalau tidak ada yang tersirat, jawab [].",
    "Kalimat:",
    ...candidates.map((c) => `- ${c}`),
  ].join("\n");
}

const IMPLICIT_MAX_ITEMS = 5;

/** Parses one model reply into facts. Never throws: garbage, a wrong
 *  shape, or a secret in the output all yield [] (or the clean items).
 *  The caller makes exactly ONE call per run — this function never retries. */
export function parseImplicitFacts(reply: string): FreshFact[] {
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: FreshFact[] = [];
  const seen = new Set<string>();
  for (const item of parsed.slice(0, IMPLICIT_MAX_ITEMS)) {
    if (typeof item !== "object" || item === null) continue;
    const { kind, text } = item as Record<string, unknown>;
    if (kind !== "preferensi" && kind !== "fakta") continue;
    if (typeof text !== "string") continue;
    const fact = cleanFact(kind, text);
    if (!fact) continue;
    const key = `${fact.kind}:${fact.text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fact);
  }
  return out;
}

/**
 * Runs the optional model-assisted extraction over one finished run's
 * transcript. Makes at most ONE call, and only when every gate passes:
 * the env flag is on, a `:free` model name was supplied, and there is at
 * least one implicit candidate. Any failure of the call itself (quota,
 * 429, network, bad output) returns [] — the feature self-disables for
 * that run and the rule-based extraction is unaffected.
 */
export async function extractImplicitFacts(
  candidates: string[],
  callFreeModel: FreeModelCall,
): Promise<FreshFact[]> {
  if (candidates.length === 0) return [];
  try {
    const reply = await callFreeModel(buildImplicitExtractPrompt(candidates));
    return parseImplicitFacts(reply);
  } catch {
    return [];
  }
}

export interface ImplicitExtractDeps {
  /** BIKININ_MEMORY_MODEL_EXTRACT — off by default. */
  enabled: boolean;
  /** First `:free` provider's model name; undefined when none is configured. */
  freeModel?: string;
  /** Single direct call against that free provider (no fallback chain). */
  callFreeModel: FreeModelCall;
}

/**
 * The whole gate in one place, so the call site stays trivial: off →
 * no call; no free provider → no call; nothing implicit to extract →
 * no call. Returns [] in all three cases, and also when the model call
 * itself fails. Never throws, never touches a paid model.
 */
export async function extractImplicitPreferences(
  transcript: Msg[],
  deps: ImplicitExtractDeps,
): Promise<FreshFact[]> {
  if (!deps.enabled) return [];
  if (!deps.freeModel || !isFreeModel(deps.freeModel)) return [];
  const candidates = collectImplicitCandidates(transcript);
  if (candidates.length === 0) return [];
  return extractImplicitFacts(candidates, deps.callFreeModel);
}

const LINE_RE =
  /^-\s*\[(\d{4}-\d{2}-\d{2})\]\s*\((fakta|preferensi|keputusan|hasil)\)\s*(.+)$/;

/** Parses workspace/.bikinin/memory.md. Lines that do not match are ignored. */
export function parseMemory(text: string): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  for (const line of text.split("\n")) {
    const m = LINE_RE.exec(line.trim());
    if (!m) continue;
    if (containsSecret(m[3])) continue;
    out.push({ date: m[1], kind: m[2] as MemoryKind, text: m[3].trim() });
  }
  return out;
}

const HEADER = [
  "# Memori Bikinin AI",
  "",
  "<!-- File ini ditulis otomatis oleh agent dari obrolan sebelumnya. -->",
  "<!-- Jangan tulis rahasia di sini: API key, token, kata sandi, kode klaim. -->",
  "<!-- Format: - [YYYY-MM-DD] (jenis) isi — jenis: fakta, preferensi, keputusan, hasil. -->",
  "",
].join("\n");

export function formatMemory(entries: MemoryEntry[]): string {
  const lines = entries.map((e) => `- [${e.date}] (${e.kind}) ${e.text}`);
  return `${HEADER}${lines.join("\n")}\n`;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Merges fresh facts into the stored entries: drops secrets and duplicates
 * (exact match, or one text containing the other), newest first, and caps
 * the total at MEMORY_MAX_BYTES by dropping the oldest entries.
 */
export function mergeFacts(
  existing: MemoryEntry[],
  fresh: FreshFact[],
  today: string,
): MemoryEntry[] {
  const merged = [...existing];
  for (const f of fresh) {
    const text = f.text.replace(/\s+/g, " ").trim();
    if (text.length < 8 || containsSecret(text)) continue;
    const n = normalize(text);
    let skip = false;
    for (let i = merged.length - 1; i >= 0; i--) {
      const en = normalize(merged[i].text);
      if (en === n || en.includes(n)) {
        skip = true; // already stored, same or more specific
        break;
      }
      if (n.includes(en)) merged.splice(i, 1); // new fact is more specific: replace
    }
    if (skip) continue;
    merged.push({ date: today, kind: f.kind, text });
  }
  // Newest first (fresh entries carry today's date), then enforce the cap.
  merged.sort((a, b) => b.date.localeCompare(a.date));
  let bytes = Buffer.byteLength(HEADER, "utf8");
  const kept: MemoryEntry[] = [];
  for (const e of merged) {
    const line = `- [${e.date}] (${e.kind}) ${e.text}\n`;
    const b = Buffer.byteLength(line, "utf8");
    if (bytes + b > MEMORY_MAX_BYTES && kept.length > 0) break;
    bytes += b;
    kept.push(e);
  }
  return kept;
}

/* ---------- relevance-ranked retrieval (Fase 8) ---------- */

// Same tokenization as lessons.ts (kept separate to avoid an import
// cycle: lessons.ts already imports containsSecret from here).
const MEMORY_STOPWORDS = new Set([
  "yang",
  "dan",
  "untuk",
  "dengan",
  "saya",
  "aku",
  "tolong",
  "buat",
  "bikin",
  "buatkan",
  "bikinin",
  "dari",
  "atau",
  "jangan",
  "bisa",
  "sudah",
  "lagi",
  "ini",
  "itu",
  "apa",
  "bagaimana",
  "kenapa",
]);

function queryTokens(query: string): string[] {
  const tokens = normalize(query)
    .split(" ")
    .filter((t) => t.length >= 3 && !MEMORY_STOPWORDS.has(t));
  return [...new Set(tokens)];
}

/**
 * Ranks memory entries for the current message: keyword overlap with the
 * query first, newest first on ties — the same pattern as selectLessons.
 * Entries with no overlap are NOT dropped: they backfill the leftover
 * budget newest-first, so durable identity facts ("namaku Rizqi") still
 * reach the prompt when nothing relevant exists, but a relevant old
 * entry always beats an irrelevant new one. With an empty query (or no
 * usable tokens) this is plain newest-first, i.e. the old behaviour.
 */
export function selectMemoryEntries(
  entries: MemoryEntry[],
  query: string,
  budgetChars: number = MEMORY_INJECT_BUDGET,
): MemoryEntry[] {
  const tokens = queryTokens(query);
  const ranked =
    tokens.length === 0
      ? [...entries].sort((a, b) => b.date.localeCompare(a.date))
      : [...entries]
          .map((e) => {
            const text = normalize(e.text);
            const score = tokens.filter((t) => text.includes(t)).length;
            return { entry: e, score };
          })
          .sort(
            (a, b) =>
              b.score - a.score || b.entry.date.localeCompare(a.entry.date),
          )
          .map(({ entry }) => entry);
  const picked: MemoryEntry[] = [];
  let used = 0;
  for (const e of ranked) {
    const line = `- [${e.date}] (${e.kind}) ${e.text}`;
    if (used + line.length + 1 > budgetChars && picked.length > 0) break;
    used += line.length + 1;
    picked.push(e);
  }
  return picked;
}

export interface SessionLine {
  id: string;
  title: string;
  updatedAt: number;
}

/**
 * The slice injected into the system prompt at the start of every run:
 * memory entries ranked by relevance to `query` (the current user
 * message) + recency, within MEMORY_INJECT_BUDGET chars, then a one-line
 * list of recent sessions so the agent can reference earlier work
 * ("kemarin kamu minta bikinin web X"). Empty string when there is nothing.
 * With no query the ranking is newest-first (the pre-Fase-8 behaviour).
 */
export function buildMemoryContext(
  entries: MemoryEntry[],
  sessions: SessionLine[],
  currentSessionId: string | null,
  query = "",
): string {
  const parts: string[] = [];
  const picked = selectMemoryEntries(entries, query);
  if (picked.length > 0) {
    parts.push(
      "# Memori dari obrolan sebelumnya (ingat ini saat menjawab)\n" +
        picked.map((e) => `- [${e.date}] (${e.kind}) ${e.text}`).join("\n"),
    );
  }
  const recent = sessions
    .filter((s) => s.id !== currentSessionId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5);
  if (recent.length > 0) {
    parts.push(
      "Sesi terakhir:\n" +
        recent
          .map(
            (s) =>
              `- ${new Date(s.updatedAt).toISOString().slice(0, 10)} — ${s.title.slice(0, 80)} (${s.id})`,
          )
          .join("\n"),
    );
  }
  return parts.join("\n\n");
}
