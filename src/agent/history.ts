// Conversation memory for a session. A run's transcript is compacted (long tool output and long
// tool arguments are cut) and replayed to the model on the next run, so the agent remembers
// what was asked and what it did. Oldest runs are dropped first when over budget.
import type { ChatCompletionMessageParam as Msg } from "openai/resources/chat/completions";

const TOOL_OUTPUT_KEEP = 1200;
const ARG_STRING_KEEP = 300;
const ARG_STRING_HEAD = 200;
export const HISTORY_CHAR_BUDGET = 80_000;
export const MAX_SESSIONS = 20;

const size = (msgs: Msg[]): number =>
  msgs.reduce((n, m) => n + JSON.stringify(m).length, 0);

function cut(text: string, keep: number): string {
  return text.length <= keep
    ? text
    : `${text.slice(0, keep)}…[dipotong ${text.length - keep} karakter]`;
}

function compactArgs(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (typeof parsed !== "object" || parsed === null) return "{}";
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed)) {
      out[k] =
        typeof v === "string" && v.length > ARG_STRING_KEEP
          ? `${v.slice(0, ARG_STRING_HEAD)}…[dipotong ${v.length - ARG_STRING_HEAD} karakter, baca ulang dengan read_file]`
          : v;
    }
    return JSON.stringify(out);
  } catch {
    return "{}";
  }
}

/** Drops a trailing assistant tool-call turn whose tool results are missing (the API rejects it). */
function dropIncomplete(msgs: Msg[]): Msg[] {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== "assistant" || !m.tool_calls || m.tool_calls.length === 0)
      continue;
    const need = new Set(m.tool_calls.map((c) => c.id));
    let j = i + 1;
    while (j < msgs.length && msgs[j].role === "tool") {
      const t = msgs[j];
      if (t.role === "tool") need.delete(t.tool_call_id);
      j++;
    }
    if (need.size > 0) return msgs.slice(0, i);
  }
  return msgs;
}

/** Shrinks one run's messages (everything after the system prompt) for storage. */
export function compactRun(msgs: Msg[]): Msg[] {
  return dropIncomplete(msgs).map((m): Msg => {
    if (m.role === "tool" && typeof m.content === "string") {
      return { ...m, content: cut(m.content, TOOL_OUTPUT_KEEP) };
    }
    if (m.role === "assistant" && m.tool_calls) {
      return {
        ...m,
        tool_calls: m.tool_calls.map((c) =>
          c.type === "function"
            ? {
                ...c,
                function: {
                  ...c.function,
                  arguments: compactArgs(c.function.arguments),
                },
              }
            : c,
        ),
      };
    }
    return m;
  });
}

export class SessionHistory {
  private runs: Msg[][] = [];

  /** Restores a history saved with toJSON(). Bad data is dropped, never throws. */
  static fromJSON(data: unknown): SessionHistory {
    const h = new SessionHistory();
    if (!Array.isArray(data)) return h;
    for (const run of data) {
      if (!Array.isArray(run)) continue;
      const msgs: Msg[] = [];
      for (const m of run) {
        if (
          typeof m !== "object" ||
          m === null ||
          typeof (m as { role?: unknown }).role !== "string" ||
          !["user", "assistant", "tool"].includes((m as { role: string }).role)
        )
          continue;
        msgs.push(m as Msg);
      }
      if (msgs.length > 0) h.runs.push(msgs);
    }
    while (h.runs.length > 1 && h.chars() > HISTORY_CHAR_BUDGET) h.runs.shift();
    return h;
  }

  /** Plain data for disk: the compacted runs, already budget-trimmed. */
  toJSON(): Msg[][] {
    return JSON.parse(JSON.stringify(this.runs)) as Msg[][];
  }

  add(transcript: Msg[]): void {
    const run = compactRun(transcript);
    if (run.length > 0) this.runs.push(run);
    // Keep at least the newest run, even if it alone is over budget.
    while (this.runs.length > 1 && this.chars() > HISTORY_CHAR_BUDGET)
      this.runs.shift();
  }

  messages(): Msg[] {
    return this.runs.flat();
  }

  get runCount(): number {
    return this.runs.length;
  }

  private chars(): number {
    return this.runs.reduce((n, r) => n + size(r), 0);
  }
}
