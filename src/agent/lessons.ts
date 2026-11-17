// Episodic memory: lessons learned from failed or repeated runs.
// Pure logic (no filesystem here) so it is easy to test. Disk lives in
// src/server/persistence.ts. Design choice, documented:
// - Extraction is RULE-BASED and deterministic, never a model call. Only
//   signals visible in the run itself are used: a tool failing repeatedly,
//   a retry loop, a run ending budget_exceeded/error, and a fix that worked
//   after an error. Raw transcripts are never stored here; session
//   transcripts live in the per-session files.
// - Anything that looks like a secret is dropped before it can be written.
// - Injection is a small char-budgeted slice of the lessons whose keywords
//   overlap the current request, prepended to the system prompt, so the
//   model sees the relevant past mistakes without blowing the token budget.
import type { ChatCompletionMessageParam as Msg } from "openai/resources/chat/completions";
import { containsSecret } from "./memory.js";

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

/**
 * Deterministic extraction from one finished run. Reads the transcript for
 * failure signals only (assistant tool calls + tool results), plus the final
 * status and summary. Returns [] when the run taught nothing durable — a
 * clean run, or a single failure the agent fixed on the first retry, leaves
 * no lesson. The caller then writes nothing.
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
  // What finally worked after the failures, if anything: the first success
  // of a different tool that came after the last failure.
  const lastFailureIdx = outcomes.reduce((acc, o, i) => (!o.ok ? i : acc), -1);
  const fix =
    lastFailureIdx >= 0
      ? outcomes
          .slice(lastFailureIdx + 1)
          .find((o) => o.ok && o.tool !== outcomes[lastFailureIdx].tool)
      : undefined;

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

  return out;
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
