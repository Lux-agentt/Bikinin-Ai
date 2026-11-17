// On-disk event log (Fase 1): every event a run emits is appended as one
// NDJSON line to workspace/.bikinin/sessions/<session_id>.jsonl — the same
// .bikinin dir the session .json and memory.md already use. The log is the
// source of truth for --continue (replay.ts rebuilds history from it) and
// for the UI replay after a restart.
//
// Safety: events are scrubbed before they touch disk. The emitter already
// redacts tool args, but model text or tool output could still echo a secret
// the user pasted. Value-shaped secrets are replaced with [rahasia]; the
// event structure is never changed, so replay keeps working.
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { AgentEvent, toNDJSON } from "../events.js";
import { MEMORY_DIR, SESSIONS_DIR } from "./persistence.js";

export function sessionLogPath(workspace: string, sessionId: string): string {
  return join(workspace, MEMORY_DIR, SESSIONS_DIR, `${sessionId}.jsonl`);
}

// Value-shaped secrets only (a credential noun without a value is left
// alone — redacting the word "password" would mangle ordinary sentences).
const REDACT_PATTERNS: Array<{ re: RegExp; replace: string }> = [
  { re: /sk-[A-Za-z0-9]{16,}/g, replace: "[rahasia]" },
  { re: /sk-ant-[A-Za-z0-9_-]{8,}/g, replace: "[rahasia]" },
  { re: /gh[pousr]_[A-Za-z0-9]{20,}/g, replace: "[rahasia]" },
  { re: /xox[baprs]-[A-Za-z0-9-]{8,}/g, replace: "[rahasia]" },
  {
    re: /Bearer\s+[A-Za-z0-9._~+/-]{16,}/gi,
    replace: "Bearer [rahasia]",
  },
  {
    re: /-----BEGIN (?:.* )?PRIVATE KEY-----[\s\S]*?-----END (?:.* )?PRIVATE KEY-----/g,
    replace: "[rahasia]",
  },
  {
    // api_key=... / password=... assignments: keep the name, drop the value.
    re: /((?:api[_-]?key|api[_-]?token|password|kata[_-]?sandi|secret)\s*=\s*)["']?[^\s"']+/gi,
    replace: "$1[rahasia]",
  },
  { re: /\b[A-Fa-f0-9]{32}\b/g, replace: "[rahasia]" },
  { re: /\b[A-Za-z0-9_-]{40,}\b/g, replace: "[rahasia]" },
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const { re, replace } of REDACT_PATTERNS) out = out.replace(re, replace);
  return out;
}

/** Deep-clones an event with every string value secret-scrubbed. */
export function scrubEvent(e: AgentEvent): AgentEvent {
  return JSON.parse(
    JSON.stringify(e, (_key, value) =>
      typeof value === "string" ? redactSecrets(value) : value,
    ),
  ) as AgentEvent;
}

export interface EventLog {
  /** Queues one event for append. Never throws; ordering is preserved. */
  append(e: AgentEvent): void;
  /** Resolves once every queued append has reached disk. */
  flush(): Promise<void>;
}

/** Serialized appends (one promise chain) so lines never interleave. */
export function createEventLog(workspace: string, sessionId: string): EventLog {
  const path = sessionLogPath(workspace, sessionId);
  let ready: Promise<void> | null = null;
  let chain: Promise<void> = Promise.resolve();
  const ensureDir = () => {
    ready ??= mkdir(join(workspace, MEMORY_DIR, SESSIONS_DIR), {
      recursive: true,
    }).then(() => undefined);
    return ready;
  };
  return {
    append(e: AgentEvent): void {
      const line = toNDJSON(scrubEvent(e));
      chain = chain
        .then(() => ensureDir())
        .then(() => appendFile(path, line, "utf8"))
        .catch(() => {
          // Logging must never fail a run. The in-memory event buffer
          // (runs.ts) and the session .json still hold the run.
        });
    },
    flush(): Promise<void> {
      return chain;
    },
  };
}

/**
 * All valid events of one session, in file order. Corrupt lines are skipped
 * (a torn last line after a crash must not break --continue). Missing file
 * means no events.
 */
export async function readSessionEvents(
  workspace: string,
  sessionId: string,
): Promise<AgentEvent[]> {
  let text: string;
  try {
    text = await readFile(sessionLogPath(workspace, sessionId), "utf8");
  } catch {
    return [];
  }
  const out: AgentEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = AgentEvent.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // corrupt line: skip it, keep the rest
    }
  }
  return out;
}

export async function deleteSessionLog(
  workspace: string,
  sessionId: string,
): Promise<void> {
  await rm(sessionLogPath(workspace, sessionId), { force: true });
}
