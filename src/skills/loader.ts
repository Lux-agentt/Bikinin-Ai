// Reads skill definitions from skills/*/SKILL.md frontmatter (AGENTS.md Lampiran C).
// Only name + description are exposed; the full file is read by the agent on demand.
// Returns [] when the folder does not exist yet (Fase 2 not done).
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface SkillInfo {
  name: string;
  description: string;
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
      const front = text.match(/^---\s*\n([\s\S]*?)\n---/);
      if (!front) continue;
      const name = /name:\s*(.+)/.exec(front[1])?.[1]?.trim();
      const description = /description:\s*(.+)/.exec(front[1])?.[1]?.trim();
      if (name && description) out.push({ name, description });
    } catch {
      // Skip unreadable skills; a broken skill must not break the list.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
