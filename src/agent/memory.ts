// Long-term memory: durable facts the agent learned across sessions.
// Pure logic (no filesystem here) so it is easy to test. Disk lives in
// src/server/persistence.ts. Design choice, documented:
// - Extraction is RULE-BASED and deterministic, never a model call. Only
//   explicit user-stated identity/preferences/decisions/rules and concrete
//   run outcomes (files created/changed) are recorded. Raw transcripts are
//   never stored here; session transcripts live in the per-session files.
// - Anything that looks like a secret is dropped before it can be written.
// - Injection is a small char-budgeted slice (newest first) prepended to the
//   system prompt, so the model sees it without blowing the token budget.
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

export interface SessionLine {
  id: string;
  title: string;
  updatedAt: number;
}

/**
 * The slice injected into the system prompt at the start of every run:
 * newest memory entries first within MEMORY_INJECT_BUDGET chars, then a
 * one-line list of recent sessions so the agent can reference earlier work
 * ("kemarin kamu minta bikinin web X"). Empty string when there is nothing.
 */
export function buildMemoryContext(
  entries: MemoryEntry[],
  sessions: SessionLine[],
  currentSessionId: string | null,
): string {
  const parts: string[] = [];
  const sorted = [...entries].sort((a, b) => b.date.localeCompare(a.date));
  const picked: MemoryEntry[] = [];
  let used = 0;
  for (const e of sorted) {
    const line = `- [${e.date}] (${e.kind}) ${e.text}`;
    if (used + line.length + 1 > MEMORY_INJECT_BUDGET && picked.length > 0)
      break;
    used += line.length + 1;
    picked.push(e);
  }
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
