// Episodic memory: lessons learned from failed or repeated runs.
// Pure logic (no filesystem here) so it is easy to test. Disk lives in
// src/server/persistence.ts. Design choice, documented:
// - Extraction is RULE-BASED by default and deterministic: only signals
//   visible in the run itself are used (a tool failing repeatedly, a retry
//   loop, a run ending budget_exceeded/error, and a fix that worked after
//   an error). Raw transcripts are never stored here; session transcripts
//   live in the per-session files.
// - Auto-learn (28 Nov 2026, owner rule: "biar auto learn"): ONE extra
//   model call per finished run (extractLessonsWithModel) lets the model
//   write the lesson itself — root cause + the correct fix, with evidence
//   — instead of the rule template "coba tool lain". It runs only against
//   a `:free` provider, never throws, and the rule-based lessons always
//   run first, so a model failure leaves rule-only lessons.
// - Anything that looks like a secret is dropped before it can be written.
// - Injection is a small char-budgeted slice of the lessons whose keywords
//   overlap the current request, prepended to the system prompt, so the
//   model sees the relevant past mistakes without blowing the token budget.
import type { ChatCompletionMessageParam as Msg } from "openai/resources/chat/completions";
import { containsSecret, isFreeModel } from "./memory.js";

export const LESSONS_INJECT_BUDGET = 2000; // chars injected into the system prompt
export const LESSONS_MAX_BYTES = 32 * 1024; // cap for the lessons file on disk
export const LESSON_TASK_MAX = 120; // chars for the task field
export const LESSON_FIELD_MAX = 200; // chars for gagal/berhasil/aturan

export interface LessonEntry {
  date: string; // YYYY-MM-DD
  task: string; // short description of what the run was trying to do
  gagal: string; // what failed
  berhasil: string; // what finally worked ("" when nothing worked)
  aturan: string; // the rule to remember next time
}

export type FreshLesson = Omit<LessonEntry, "date">;

/** Extra run signals a caller may pass; when omitted they are derived from
 *  the transcript. Only steps/failedToolCalls carry information the
 *  transcript does not already show. */
export interface RunSignals {
  /** Total agent steps used (AgentResult.totals.steps). */
  steps?: number;
  /** Tool calls that failed (tool_call_finished ok:false count). */
  failedToolCalls?: number;
}

interface ToolCall {
  id: string;
  tool: string;
  args: string; // short, human-readable argument summary
}

interface ToolOutcome {
  tool: string;
  ok: boolean;
  summary: string; // first line of the tool result, prefix stripped
}

function toolCallArgs(call: {
  function?: { name?: string; arguments?: string };
}): ToolCall {
  const name = call.function?.name ?? "tool";
  let args = "";
  try {
    const parsed: unknown = JSON.parse(call.function?.arguments ?? "{}");
    if (typeof parsed === "object" && parsed !== null) {
      const p = parsed as Record<string, unknown>;
      const first =
        typeof p.path === "string"
          ? p.path
          : typeof p.command === "string"
            ? p.command
            : typeof p.name === "string"
              ? p.name
              : "";
      args = String(first);
    }
  } catch {
    args = "";
  }
  return { id: "", tool: name, args };
}

function firstLine(text: string): string {
  return text
    .split("\n")[0]
    .replace(/^(OK|GAGAL|ERROR):\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pairs assistant tool_calls with the tool results that follow them, in
 * transcript order. A tool message with an unknown call id is paired with
 * the oldest unpaired call.
 */
function collectOutcomes(transcript: Msg[]): ToolOutcome[] {
  const pending: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  const out: ToolOutcome[] = [];
  for (const m of transcript) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) {
        // Custom tool calls (no function payload) carry no tool name.
        if (!("function" in c)) continue;
        const call = toolCallArgs(c);
        call.id = typeof c.id === "string" ? c.id : "";
        pending.push(call);
        if (call.id) byId.set(call.id, call);
      }
    } else if (m.role === "tool" && typeof m.content === "string") {
      const id = typeof m.tool_call_id === "string" ? m.tool_call_id : "";
      const call = (id && byId.get(id)) ?? pending.shift();
      if (!call) continue;
      if (id) byId.delete(id);
      const idx = pending.indexOf(call);
      if (idx >= 0) pending.splice(idx, 1);
      const ok = !/^(GAGAL|ERROR):/i.test(m.content.trim());
      out.push({ tool: call.tool, ok, summary: firstLine(m.content) });
    }
  }
  return out;
}

function userTask(transcript: Msg[], summary: string): string {
  for (const m of transcript) {
    if (m.role === "user" && typeof m.content === "string") {
      const t = m.content.replace(/\s+/g, " ").trim();
      if (t.length > 0) return t.slice(0, LESSON_TASK_MAX);
    }
  }
  return (
    firstLine(summary).slice(0, LESSON_TASK_MAX) || "tugas tidak diketahui"
  );
}

/** What finally worked after the failures, if anything: the first success
 *  of a different tool that came after the last failure. */
function findFix(outcomes: ToolOutcome[]): ToolOutcome | undefined {
  const lastFailureIdx = outcomes.reduce((acc, o, i) => (!o.ok ? i : acc), -1);
  return lastFailureIdx >= 0
    ? outcomes
        .slice(lastFailureIdx + 1)
        .find((o) => o.ok && o.tool !== outcomes[lastFailureIdx].tool)
    : undefined;
}

/** Derives the run signals from the transcript alone. */
export function deriveSignals(transcript: Msg[]): RunSignals {
  const outcomes = collectOutcomes(transcript);
  return {
    steps: outcomes.length,
    failedToolCalls: outcomes.filter((o) => !o.ok).length,
  };
}

function cleanField(text: string, max: number): string {
  return text.replace(/\s+/g, " ").replace(/\|/g, "/").trim().slice(0, max);
}

function cleanLesson(l: FreshLesson): FreshLesson | null {
  const cleaned: FreshLesson = {
    task: cleanField(l.task, LESSON_TASK_MAX),
    gagal: cleanField(l.gagal, LESSON_FIELD_MAX),
    berhasil: cleanField(l.berhasil, LESSON_FIELD_MAX),
    aturan: cleanField(l.aturan, LESSON_FIELD_MAX),
  };
  if (cleaned.task.length < 3 || cleaned.gagal.length < 8) return null;
  if (cleaned.aturan.length < 8) return null;
  if (
    containsSecret(cleaned.task) ||
    containsSecret(cleaned.gagal) ||
    containsSecret(cleaned.berhasil) ||
    containsSecret(cleaned.aturan)
  ) {
    return null;
  }
  return cleaned;
}

/** Kata/frasa yang menandai pesan pengguna sebagai koreksi atas hasil sebelumnya. */
const CORRECTION_RE =
  /\b(salah|bukan|jelek|harusnya|seharusnya|ganti|jangan|maksud|kok|kenapa|benerin|perbaiki|tidak sesuai|nggak sesuai|ga sesuai|salah paham|kurang bagus|kurang cocok|kurang rapi|masih gabisa|masih kosong|masih jelek|masih salah|tetap jelek|tetap salah|belum bisa|belum benar)\b/i;

/** Pesan pengguna pertama di run ini bila isinya koreksi — null bila bukan. */
function firstCorrectionMessage(transcript: Msg[]): string | null {
  for (const m of transcript) {
    if (m.role === "user" && typeof m.content === "string") {
      const text = m.content.replace(/\s+/g, " ").trim();
      if (text.length >= 8 && CORRECTION_RE.test(text)) {
        return text.slice(0, LESSON_TASK_MAX);
      }
      return null;
    }
  }
  return null;
}

/**
 * Deterministic extraction from one finished run. Reads the transcript for
 * failure signals (assistant tool calls + tool results) and for user
 * corrections of the previous result, plus the final status and summary.
 * Returns [] when the run taught nothing durable — a clean run, or a single
 * failure the agent fixed on the first retry, leaves no lesson. The caller
 * then writes nothing.
 */
export function extractLessons(
  transcript: Msg[],
  summary: string,
  status: string,
  signals: RunSignals = deriveSignals(transcript),
): FreshLesson[] {
  const outcomes = collectOutcomes(transcript);
  const task = userTask(transcript, summary);
  const out: FreshLesson[] = [];
  const seen = new Set<string>();
  const push = (l: FreshLesson | null) => {
    if (!l) return;
    const key = l.aturan.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(l);
  };

  // Per-tool failure counts, in call order.
  const failures = new Map<string, { count: number; lastError: string }>();
  const successes: ToolOutcome[] = [];
  for (const o of outcomes) {
    if (o.ok) {
      successes.push(o);
    } else {
      const f = failures.get(o.tool) ?? { count: 0, lastError: "" };
      f.count += 1;
      f.lastError = o.summary;
      failures.set(o.tool, f);
    }
  }
  const fix = findFix(outcomes);

  for (const [tool, f] of failures) {
    if (f.count < 2) continue;
    push(
      cleanLesson({
        task,
        gagal: `${tool} gagal ${f.count}×: ${f.lastError}`,
        berhasil: fix ? `${fix.tool} berhasil: ${fix.summary}` : "",
        aturan: fix
          ? `Jika ${tool} gagal berulang, jangan ulangi cara yang sama — coba ${fix.tool} seperti yang akhirnya berhasil.`
          : `Jika ${tool} gagal 2× dengan cara yang sama, berhenti mengulang dan coba cara lain atau tanya pengguna.`,
      }),
    );
  }

  // One failure followed by a different tool fixing it is a workaround
  // worth remembering, even without repetition.
  if (failures.size === 1 && fix && status === "completed") {
    const [tool, f] = [...failures.entries()][0];
    push(
      cleanLesson({
        task,
        gagal: `${tool} gagal: ${f.lastError}`,
        berhasil: `${fix.tool} berhasil: ${fix.summary}`,
        aturan: `Saat ${tool} gagal (${f.lastError}), coba ${fix.tool} — itu yang akhirnya berhasil.`,
      }),
    );
  }

  if (status === "budget_exceeded") {
    const steps =
      typeof signals.steps === "number" && signals.steps > 0
        ? ` setelah ${signals.steps} langkah`
        : "";
    push(
      cleanLesson({
        task,
        gagal: `Run kehabisan langkah/biaya sebelum tugas selesai${steps}`,
        berhasil: "",
        aturan:
          "Buat rencana maks 5 langkah, kerjakan yang paling penting dulu, dan jangan ulangi tool call yang sudah gagal.",
      }),
    );
  }

  if (status === "error") {
    const lastError =
      [...failures.values()].map((f) => f.lastError).pop() ??
      firstLine(summary);
    push(
      cleanLesson({
        task,
        gagal: `Run berakhir error: ${lastError}`,
        berhasil: "",
        aturan:
          "Saat run berakhir error, baca pesan errornya sampai paham penyebabnya sebelum mengulang — jangan ulangi perintah yang sama.",
      }),
    );
  }

  // Koreksi pengguna: pesan yang memperbaiki hasil sebelumnya ("tampilan
  // dichatnya kurang bagus", "maksud simple saya tu..."). Aturan lama cuma
  // membaca kegagalan tool — koreksi seperti ini tidak pernah jadi
  // pelajaran, jadi agent mengulang kesalahan yang sama di chat/tugas lain.
  // Satu pelajaran per run, hanya bila run selesai (koreksinya sudah
  // dikerjakan). cleanLesson tetap menyaring rahasia (API key dsb).
  if (status === "completed") {
    const correction = firstCorrectionMessage(transcript);
    if (correction) {
      push(
        cleanLesson({
          task: correction,
          gagal: `Hasil sebelumnya tidak sesuai harapan pengguna: ${correction}`,
          berhasil: "Agent mengerjakan ulang sesuai koreksi dan run selesai.",
          aturan: `Perhatikan koreksi pengguna: "${correction}" — jangan ulangi kesalahan yang sama.`,
        }),
      );
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Auto-learn: the model writes the lesson itself (28 Nov 2026, owner rule).
// The rule-based extraction above can only say "try another tool" — it
// cannot name the root cause (e.g. "Root.tsx registers no <Composition>").
// This pass asks the model, once per finished run, to evaluate its own
// failures the way the agent-self-evaluation skill teaches: score the gap
// with EVIDENCE, name the root cause, and state the correct fix. The reply
// is parsed with the same strict line format and secret filter as the
// rule-based lessons, so a bad model reply can only add nothing.
// ---------------------------------------------------------------------------

export interface LessonExtractDeps {
  /** BIKININ_LESSONS_MODEL_EXTRACT — on by default. */
  enabled: boolean;
  /** First `:free` provider's model name; undefined when none is configured. */
  freeModel?: string;
  /** Single direct call against that free provider (no fallback chain). */
  callFreeModel: (prompt: string) => Promise<string>;
}

interface LessonSignals {
  task: string;
  failures: Array<{ tool: string; count: number; lastError: string }>;
  fix?: { tool: string; summary: string };
  correction?: string | null;
  status: string;
}

function buildLessonExtractPrompt(s: LessonSignals): string {
  const lines = [
    "Kamu mengevaluasi satu run agent yang baru selesai. Tulis pelajaran dari kegagalannya — bukan sekadar 'coba tool lain', tapi penyebab AKAR + perbaikan yang BENAR, dengan bukti dari log.",
    "",
    `Tugas: ${s.task}`,
    `Status run: ${s.status}`,
  ];
  for (const f of s.failures)
    lines.push(`Gagal: ${f.tool} (${f.count}x) — ${f.lastError}`);
  if (s.fix)
    lines.push(`Yang akhirnya berhasil: ${s.fix.tool} — ${s.fix.summary}`);
  if (s.correction) lines.push(`Koreksi pengguna: ${s.correction}`);
  lines.push(
    "",
    "Tulis MAKS 3 pelajaran, satu per baris, format persis ini (jangan tambah teks lain):",
    "Tugas: <tugas singkat> | Gagal: <apa yang gagal + bukti> | Berhasil: <yang akhirnya berhasil, kosongkan bila tidak ada> | Aturan: <aturan untuk run berikutnya — sebut penyebab akar dan perbaikan yang benar, bukan 'coba tool lain'>",
    "Bila run tidak mengajarkan apa pun yang tahan lama, balas dengan baris kosong.",
    "Jangan tulis rahasia (API key, token, kata sandi, kode klaim).",
  );
  return lines.join("\n");
}

const LESSON_LINE_RE =
  /Tugas:\s*(.+?)\s*\|\s*Gagal:\s*(.+?)\s*\|\s*Berhasil:\s*(.*?)\s*\|\s*Aturan:\s*(.+)/;

/** Parses the model reply: at most 3 well-formed lines, each secret-filtered. */
function parseLessonLines(reply: string): FreshLesson[] {
  const out: FreshLesson[] = [];
  for (const line of reply.split("\n")) {
    const m = LESSON_LINE_RE.exec(line.trim());
    if (!m) continue;
    const cleaned = cleanLesson({
      task: m[1],
      gagal: m[2],
      berhasil: m[3],
      aturan: m[4],
    });
    if (cleaned) out.push(cleaned);
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * Model-assisted lesson extraction. Same gate as the memory equivalent:
 * off → no call; no free provider → no call; nothing worth learning from
 * the run → no call. Returns [] in all three cases, and also when the
 * model call itself fails. Never throws, never touches a paid model.
 */
export async function extractLessonsWithModel(
  transcript: Msg[],
  summary: string,
  status: string,
  deps: LessonExtractDeps,
): Promise<FreshLesson[]> {
  if (!deps.enabled) return [];
  if (!deps.freeModel || !isFreeModel(deps.freeModel)) return [];
  const outcomes = collectOutcomes(transcript);
  const failuresMap = new Map<string, { count: number; lastError: string }>();
  for (const o of outcomes) {
    if (o.ok) continue;
    const f = failuresMap.get(o.tool) ?? { count: 0, lastError: "" };
    f.count += 1;
    f.lastError = o.summary;
    failuresMap.set(o.tool, f);
  }
  const correction =
    status === "completed" ? firstCorrectionMessage(transcript) : null;
  const hasSignal =
    failuresMap.size > 0 ||
    correction !== null ||
    status === "budget_exceeded" ||
    status === "error";
  if (!hasSignal) return [];
  const fix = findFix(outcomes);
  try {
    const reply = await deps.callFreeModel(
      buildLessonExtractPrompt({
        task: userTask(transcript, summary),
        failures: [...failuresMap.entries()].map(([tool, f]) => ({
          tool,
          ...f,
        })),
        fix: fix ? { tool: fix.tool, summary: fix.summary } : undefined,
        correction,
        status,
      }),
    );
    return parseLessonLines(reply);
  } catch {
    return [];
  }
}

const LINE_RE =
  /^-\s*\[(\d{4}-\d{2}-\d{2})\]\s*Tugas:\s*(.+?)\s*\|\s*Gagal:\s*(.+?)\s*\|\s*Berhasil:\s*(.*?)\s*\|\s*Aturan:\s*(.+)$/;

/** Parses workspace/.bikinin/lessons.md. Lines that do not match are ignored. */
export function parseLessons(text: string): LessonEntry[] {
  const out: LessonEntry[] = [];
  for (const line of text.split("\n")) {
    const m = LINE_RE.exec(line.trim());
    if (!m) continue;
    const entry: LessonEntry = {
      date: m[1],
      task: m[2].trim(),
      gagal: m[3].trim(),
      berhasil: m[4].trim(),
      aturan: m[5].trim(),
    };
    if (
      containsSecret(entry.task) ||
      containsSecret(entry.gagal) ||
      containsSecret(entry.berhasil) ||
      containsSecret(entry.aturan)
    ) {
      continue;
    }
    out.push(entry);
  }
  return out;
}

const HEADER = [
  "# Pelajaran Bikinin AI",
  "",
  "<!-- File ini ditulis otomatis oleh agent dari run yang gagal/berulang. -->",
  "<!-- Jangan tulis rahasia di sini: API key, token, kata sandi, kode klaim. -->",
  "<!-- Format: - [YYYY-MM-DD] Tugas: ... | Gagal: ... | Berhasil: ... | Aturan: ... -->",
  "",
].join("\n");

export function formatLessons(entries: LessonEntry[]): string {
  const lines = entries.map(
    (e) =>
      `- [${e.date}] Tugas: ${e.task} | Gagal: ${e.gagal} | Berhasil: ${e.berhasil} | Aturan: ${e.aturan}`,
  );
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
 * Merges fresh lessons into the stored entries: drops secrets and duplicates
 * (same rule, or one rule containing the other), newest first, and caps the
 * total at LESSONS_MAX_BYTES by dropping the oldest entries.
 */
export function mergeLessons(
  existing: LessonEntry[],
  fresh: FreshLesson[],
  today: string,
): LessonEntry[] {
  // The file stores newest-first; reverse so this array runs oldest-first,
  // which the recency sort below relies on (later = newer on equal dates).
  const merged = [...existing].reverse();
  for (const f of fresh) {
    const cleaned = cleanLesson(f);
    if (!cleaned) continue;
    const n = normalize(cleaned.aturan);
    let skip = false;
    for (let i = merged.length - 1; i >= 0; i--) {
      const en = normalize(merged[i].aturan);
      if (en === n || en.includes(n)) {
        skip = true; // already stored, same or more specific
        break;
      }
      if (n.includes(en)) merged.splice(i, 1); // new rule is more specific: replace
    }
    if (skip) continue;
    merged.push({ date: today, ...cleaned });
  }
  // Newest first; on equal dates the later entry is the newer one.
  const sorted = merged
    .map((e, i) => ({ e, i }))
    .sort((a, b) => b.e.date.localeCompare(a.e.date) || b.i - a.i)
    .map(({ e }) => e);
  let bytes = Buffer.byteLength(HEADER, "utf8");
  const kept: LessonEntry[] = [];
  for (const e of sorted) {
    const line = `- [${e.date}] Tugas: ${e.task} | Gagal: ${e.gagal} | Berhasil: ${e.berhasil} | Aturan: ${e.aturan}\n`;
    const b = Buffer.byteLength(line, "utf8");
    if (bytes + b > LESSONS_MAX_BYTES && kept.length > 0) break;
    bytes += b;
    kept.push(e);
  }
  return kept;
}

const STOPWORDS = new Set([
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
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return [...new Set(tokens)];
}

/**
 * The lessons relevant to a request: keyword overlap between the request
 * and each lesson's text (task + failure + fix + rule), best match first,
 * newest first on ties, filled up to budgetChars. Lessons with no overlap
 * are never injected — an unrelated past failure only burns tokens.
 */
export function selectLessons(
  lessons: LessonEntry[],
  query: string,
  budgetChars: number = LESSONS_INJECT_BUDGET,
): LessonEntry[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];
  const scored = lessons
    .map((l) => {
      const text = normalize(`${l.task} ${l.gagal} ${l.berhasil} ${l.aturan}`);
      const score = tokens.filter((t) => text.includes(t)).length;
      return { lesson: l, score };
    })
    .filter((s) => s.score > 0)
    .sort(
      (a, b) => b.score - a.score || b.lesson.date.localeCompare(a.lesson.date),
    );
  const picked: LessonEntry[] = [];
  let used = 0;
  for (const { lesson } of scored) {
    const line = `- [${lesson.date}] Tugas: ${lesson.task} | Gagal: ${lesson.gagal} | Berhasil: ${lesson.berhasil} | Aturan: ${lesson.aturan}`;
    if (used + line.length + 1 > budgetChars && picked.length > 0) break;
    used += line.length + 1;
    picked.push(lesson);
  }
  return picked;
}

/**
 * The slice injected into the system prompt at the start of a run: only
 * the lessons whose keywords overlap the current request, within
 * LESSONS_INJECT_BUDGET chars. Empty string when nothing matches.
 */
export function buildLessonsContext(
  lessons: LessonEntry[],
  query: string,
): string {
  const picked = selectLessons(lessons, query);
  if (picked.length === 0) return "";
  return (
    "# Pelajaran dari run sebelumnya (jangan ulangi kesalahan yang sama)\n" +
    picked
      .map(
        (e) =>
          `- [${e.date}] Tugas: ${e.task} | Gagal: ${e.gagal} | Berhasil: ${e.berhasil} | Aturan: ${e.aturan}`,
      )
      .join("\n")
  );
}
