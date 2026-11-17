// Disk persistence for memory. Everything lives under
// workspace/.bikinin/ (already inside the gitignored workspace/, and the
// dot-prefix keeps it out of the UI file list, zip downloads, and previews,
// which skip dot-names). Writes are atomic (tmp file + rename) so a crash
// mid-write never leaves a half-written session behind.
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { ChatCompletionMessageParam as Msg } from "openai/resources/chat/completions";
import {
  formatLessons,
  mergeLessons,
  parseLessons,
  type FreshLesson,
  type LessonEntry,
} from "../agent/lessons.js";
import {
  formatMemory,
  mergeFacts,
  parseMemory,
  type FreshFact,
  type MemoryEntry,
} from "../agent/memory.js";

export const MEMORY_DIR = ".bikinin";
export const MEMORY_FILE = "memory.md";
export const LESSONS_FILE = "lessons.md";
export const SESSIONS_DIR = "sessions";

export function memoryDirPath(workspace: string): string {
  return join(workspace, MEMORY_DIR);
}

export function memoryFilePath(workspace: string): string {
  return join(workspace, MEMORY_DIR, MEMORY_FILE);
}

export function lessonsFilePath(workspace: string): string {
  return join(workspace, MEMORY_DIR, LESSONS_FILE);
}

export function sessionsDirPath(workspace: string): string {
  return join(workspace, MEMORY_DIR, SESSIONS_DIR);
}

export function sessionFilePath(workspace: string, sessionId: string): string {
  return join(workspace, MEMORY_DIR, SESSIONS_DIR, `${sessionId}.json`);
}

// Session ids are always `s_` + 8 lowercase hex chars (see runs.ts). Any
// other filename on disk is ignored on load and never deleted by pruning.
export const SESSION_ID_RE = /^s_[a-f0-9]{8}$/;

export interface PersistedSession {
  version: 1;
  session_id: string;
  title: string;
  prompts: number;
  runs: number;
  last_status: string | null;
  updated_at: number;
  history: Msg[][];
}

async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
}

export async function saveSession(
  workspace: string,
  session: PersistedSession,
): Promise<void> {
  const dir = sessionsDirPath(workspace);
  await mkdir(dir, { recursive: true });
  await atomicWrite(
    sessionFilePath(workspace, session.session_id),
    JSON.stringify(session, null, 2),
  );
}

function validSession(data: unknown): PersistedSession | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.version !== 1) return null;
  if (typeof d.session_id !== "string" || !SESSION_ID_RE.test(d.session_id))
    return null;
  if (typeof d.title !== "string") return null;
  if (typeof d.prompts !== "number" || typeof d.runs !== "number") return null;
  if (typeof d.updated_at !== "number") return null;
  if (d.last_status !== null && typeof d.last_status !== "string") return null;
  if (!Array.isArray(d.history)) return null;
  return data as PersistedSession;
}

/** All persisted sessions, newest first. Corrupt files are skipped. */
export async function loadSessions(
  workspace: string,
): Promise<PersistedSession[]> {
  let names: string[];
  try {
    names = await readdir(sessionsDirPath(workspace));
  } catch {
    return [];
  }
  const out: PersistedSession[] = [];
  for (const name of names) {
    if (!/^s_[a-f0-9]{8}\.json$/.test(name)) continue;
    try {
      const data: unknown = JSON.parse(
        await readFile(join(sessionsDirPath(workspace), name), "utf8"),
      );
      const s = validSession(data);
      if (s && s.session_id === name.slice(0, -".json".length)) out.push(s);
    } catch {
      // corrupt session file: skip it, never crash startup
    }
  }
  return out.sort((a, b) => b.updated_at - a.updated_at);
}

export async function deleteSession(
  workspace: string,
  sessionId: string,
): Promise<void> {
  if (!SESSION_ID_RE.test(sessionId)) return;
  await rm(sessionFilePath(workspace, sessionId), { force: true });
  // The event log (.jsonl) belongs to the same session: remove it too,
  // otherwise a deleted session would come back through --continue.
  // (Inline path on purpose: importing event-log.ts here would be a cycle.)
  await rm(join(workspace, MEMORY_DIR, SESSIONS_DIR, `${sessionId}.jsonl`), {
    force: true,
  });
}

/** Deletes persisted sessions beyond the newest `keep` (by updated_at). */
export async function pruneSessions(
  workspace: string,
  keep: number,
): Promise<void> {
  const sessions = await loadSessions(workspace);
  for (const s of sessions.slice(keep)) {
    await deleteSession(workspace, s.session_id);
  }
}

/** Reads the long-term memory file; missing or unreadable means empty. */
export async function readMemoryEntries(
  workspace: string,
): Promise<MemoryEntry[]> {
  try {
    return parseMemory(await readFile(memoryFilePath(workspace), "utf8"));
  } catch {
    return [];
  }
}

/**
 * Appends fresh facts to the memory file (deduped, secret-filtered, capped).
 * Returns how many entries were actually added; writes nothing when zero.
 */
export async function appendMemoryFacts(
  workspace: string,
  facts: FreshFact[],
): Promise<number> {
  if (facts.length === 0) return 0;
  const existing = await readMemoryEntries(workspace);
  const today = new Date().toISOString().slice(0, 10);
  const merged = mergeFacts(existing, facts, today);
  if (merged.length === existing.length) return 0;
  await mkdir(memoryDirPath(workspace), { recursive: true });
  await atomicWrite(memoryFilePath(workspace), formatMemory(merged));
  return merged.length - existing.length;
}

/** Reads the episodic lessons file; missing or unreadable means empty. */
export async function readLessonEntries(
  workspace: string,
): Promise<LessonEntry[]> {
  try {
    return parseLessons(await readFile(lessonsFilePath(workspace), "utf8"));
  } catch {
    return [];
  }
}

/**
 * Appends fresh lessons to the lessons file (deduped, secret-filtered,
 * capped). Returns how many entries were actually added; writes nothing
 * when zero.
 */
export async function appendLessons(
  workspace: string,
  lessons: FreshLesson[],
): Promise<number> {
  if (lessons.length === 0) return 0;
  const existing = await readLessonEntries(workspace);
  const today = new Date().toISOString().slice(0, 10);
  const merged = mergeLessons(existing, lessons, today);
  if (merged.length === existing.length) return 0;
  await mkdir(memoryDirPath(workspace), { recursive: true });
  await atomicWrite(lessonsFilePath(workspace), formatLessons(merged));
  return merged.length - existing.length;
}
