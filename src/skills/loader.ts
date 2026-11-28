// Reads skill definitions from skills/*/SKILL.md frontmatter (AGENTS.md Lampiran C).
// Only name + description + category are exposed to the model; the full file
// is read by the agent on demand via the read_skill tool. Returns [] when the
// folder does not exist yet. A broken skill is skipped, never fatal.
// Kategori (2026-11-28, aturan user: skill dikategorikan biar gampang
// dicari, TANPA ada yang dihapus): 16 topik, ditulis di frontmatter tiap
// skill sebagai `category: <slug>`; daftar prompt dikelompokkan per kategori.
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
  category: string;
}

/** Urutan kategori di daftar prompt: yang paling sering dipakai Rizqi dulu
 *  (website, video, bounty, konten), sisanya menyusul. */
export const CATEGORY_ORDER = [
  "website",
  "video",
  "web3-bounty",
  "konten-sosial",
  "backend-api",
  "framework",
  "testing-qa",
  "agent-harness",
  "orch",
  "devops-infra",
  "data-ml",
  "bisnis-ops",
  "mobile-desktop",
  "git-ops",
  "produk-perencanaan",
  "lainnya",
] as const;

export const DEFAULT_CATEGORY = "lainnya";

/** A skill name is a single directory name: lowercase letters, digits, -, _. */
export const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Skills dir, overridable for tests via BIKININ_SKILLS_DIR. */
export function skillsDir(): string {
  return process.env.BIKININ_SKILLS_DIR ?? REPO_SKILLS_DIR;
}

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

/** Parses the --- frontmatter block. Only `name`, `description` and
 *  `category` keys count. `category` is returned only when present. */
export function parseFrontmatter(text: string): {
  name?: string;
  description?: string;
  category?: string;
} {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
  if (!m) return {};
  const out: { name?: string; description?: string; category?: string } = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    if (key !== "name" && key !== "description" && key !== "category")
      continue;
    // First occurrence wins; a stray "name:" inside the description is ignored
    // because only the line's own key is read.
    if (out[key] === undefined) out[key] = stripQuotes(kv[2]);
  }
  return out;
}

/** Kategori yang sah dipakai di frontmatter; nilai lain jatuh ke default. */
function normalizeCategory(raw: string | undefined): string {
  if (raw && NAME_RE.test(raw)) return raw;
  return DEFAULT_CATEGORY;
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
      const { name, description, category } = parseFrontmatter(text);
      // The frontmatter name must match the folder name, so a skill name
      // always resolves to exactly one directory (see readSkill).
      if (name === e.name && description)
        out.push({
          name,
          description,
          category: normalizeCategory(category),
        });
    } catch {
      // Skip unreadable skills; a broken skill must not break the list.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Daftar skill untuk system prompt, dikelompokkan per kategori (satu baris
 *  per skill, `nama: deskripsi` — format barisnya sama seperti dulu, cuma
 *  ditambah judul `### <kategori>` supaya agent gampang nyari per topik).
 *  Kategori yang tidak ada di CATEGORY_ORDER diletakkan sesudah yang dikenal,
 *  urut alfabet; skill tanpa kategori masuk `lainnya`. */
export function formatSkillList(skills: SkillInfo[]): string {
  if (skills.length === 0) return "(belum ada skill)";
  const order = new Map<string, number>(
    CATEGORY_ORDER.map((c, i) => [c, i]),
  );
  const byCategory = new Map<string, SkillInfo[]>();
  for (const s of skills) {
    const cat = s.category && NAME_RE.test(s.category)
      ? s.category
      : DEFAULT_CATEGORY;
    const list = byCategory.get(cat) ?? [];
    list.push(s);
    byCategory.set(cat, list);
  }
  const cats = [...byCategory.keys()].sort((a, b) => {
    const ia = order.has(a) ? order.get(a)! : CATEGORY_ORDER.length;
    const ib = order.has(b) ? order.get(b)! : CATEGORY_ORDER.length;
    return ia - ib || a.localeCompare(b);
  });
  return cats
    .map(
      (c) =>
        `### ${c}\n` +
        [...byCategory.get(c)!]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((s) => `- ${s.name}: ${s.description}`)
          .join("\n"),
    )
    .join("\n");
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
