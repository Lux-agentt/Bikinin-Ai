// Reads skill definitions from skills/*/SKILL.md frontmatter (AGENTS.md Lampiran C).
// Only name + description are exposed to the model; the full file is read by
// the agent on demand via the read_skill tool. Returns [] when the folder
// does not exist yet. A broken skill is skipped, never fatal.
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve, sep } from "node:path";
import { AgentError } from "../errors.js";

/** Repo-root skills/ directory (the skills shipped with the agent). */
export const REPO_SKILLS_DIR = fileURLToPath(
  new URL("../../skills/", import.meta.url),
);

export interface SkillInfo {
  name: string;
  description: string;
}

/** A skill name is a single directory name: lowercase letters, digits, -, _. */
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

function stripQuotes(v: string): string {
  const t = v.trim();
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) ||
      (t.startsWith("'") && t.endsWith("'")))
  )
    return t.slice(1, -1);
  return t;
}

/** Parses the --- frontmatter block. Only `name` and `description` keys count. */
export function parseFrontmatter(
  text: string,
): { name?: string; description?: string } {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
  if (!m) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    if (key !== "name" && key !== "description") continue;
    // First occurrence wins; a stray "name:" inside the description is ignored
    // because only the line's own key is read.
    if (out[key] === undefined) out[key] = stripQuotes(kv[2]);
  }
  return out;
}

export async function listSkills(dir: string): Promise<SkillInfo[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const text = await readFile(join(dir, e.name, "SKILL.md"), "utf8");
      const { name, description } = parseFrontmatter(text);
      // The frontmatter name must match the folder name, so a skill name
      // always resolves to exactly one directory (see readSkill).
      if (name === e.name && description) out.push({ name, description });
    } catch {
      // Skip unreadable skills; a broken skill must not break the list.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** One line per skill for the system prompt (name + description only). */
export function formatSkillList(skills: SkillInfo[]): string {
  if (skills.length === 0) return "(belum ada skill)";
  return skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
}

/**
 * Reads the full SKILL.md of one skill by name. The name must be a single
 * directory name and must match a skill the loader found; anything else
 * (../, absolute paths, unknown names) is rejected before any file is read,
 * so the agent can never escape the skills directory through this tool.
 */
export async function readSkill(dir: string, name: string): Promise<string> {
  if (!NAME_RE.test(name)) {
    throw new AgentError(
      "path_blocked",
      `nama skill tidak valid: ${name}`,
      true,
    );
  }
  const root = resolve(dir);
  const abs = resolve(root, name, "SKILL.md");
  if (!abs.startsWith(root + sep)) {
    throw new AgentError(
      "path_blocked",
      `skill keluar dari folder skills: ${name}`,
      true,
    );
  }
  const known = await listSkills(dir);
  if (!known.some((s) => s.name === name)) {
    throw new AgentError("tool_failed", `skill tidak ditemukan: ${name}`, true);
  }
  try {
    return await readFile(abs, "utf8");
  } catch {
    throw new AgentError("tool_failed", `skill tidak bisa dibaca: ${name}`, true);
  }
}
