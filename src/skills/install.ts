// Installs a skill into skills/<kelompok>/<name>/SKILL.md (or
// skills/<name>/SKILL.md when its frontmatter category is not one of the 5
// known groups) from a GitHub link or pasted text. The next run picks it up
// via the Fase 8 hot reload (buildSystemPrompt re-lists skills before each
// run); no restart needed.
// Only GitHub hosts are fetched — a skill file must come from a repo the
// owner points at, never an arbitrary URL.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CATEGORY_ORDER,
  NAME_RE,
  parseFrontmatter,
  skillsDir,
} from "./loader.js";

/** A SKILL.md bigger than this is rejected (HTTP JSON bodies cap at 64 KB). */
export const MAX_SKILL_BYTES = 64 * 1024;

const FETCH_TIMEOUT_MS = 10_000;

export class InstallError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "InstallError";
  }
}

/**
 * Turns a github.com blob/raw link into its raw.githubusercontent.com
 * equivalent. A direct raw link passes through unchanged. Anything else
 * (other hosts, non-file paths) is rejected.
 */
export function toRawUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new InstallError(400, "link tidak valid — kasih link GitHub ke file SKILL.md");
  }
  if (u.protocol !== "https:") {
    throw new InstallError(400, "link harus https");
  }
  if (u.hostname === "raw.githubusercontent.com") {
    if (u.pathname.split("/").length < 5) {
      throw new InstallError(
        400,
        "link raw tidak lengkap — harus menunjuk ke satu file",
      );
    }
    return u.toString();
  }
  if (u.hostname !== "github.com") {
    throw new InstallError(
      400,
      "hanya link GitHub yang diterima (github.com atau raw.githubusercontent.com)",
    );
  }
  // /<owner>/<repo>/blob/<branch>/<path...> or /<owner>/<repo>/raw/<branch>/<path...>
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 5 || (parts[2] !== "blob" && parts[2] !== "raw")) {
    throw new InstallError(
      400,
      "link GitHub harus menunjuk ke satu file — buka file SKILL.md di GitHub lalu salin linknya",
    );
  }
  const [owner, repo, , branch, ...path] = parts;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path.join("/")}`;
}

async function fetchSkillText(url: string): Promise<string> {
  const raw = toRawUrl(url);
  let res: Response;
  try {
    res = await fetch(raw, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    throw new InstallError(502, "gagal mengunduh link itu — periksa link dan koneksi");
  }
  if (res.status === 404) {
    throw new InstallError(404, "file tidak ditemukan di link itu — periksa branch dan path-nya");
  }
  if (!res.ok) {
    throw new InstallError(502, `GitHub menolak unduhan (HTTP ${res.status})`);
  }
  const text = await res.text();
  if (text.length > MAX_SKILL_BYTES) {
    throw new InstallError(413, "file skill terlalu besar (maks 64 KB)");
  }
  return text;
}

export interface InstallSkillInput {
  name?: string;
  url?: string;
  content?: string;
}

/**
 * Validates and writes the skill. The folder name always comes from the
 * frontmatter `name` (which must match NAME_RE, so the join below cannot
 * escape the skills dir). A skill whose frontmatter `category` is one of
 * the 5 known groups lands in skills/<kelompok>/<name>/; anything else
 * lands flat in skills/<name>/. Refuses when the skill already exists —
 * remove the old folder first if it is meant to be replaced.
 */
export async function installSkill(
  input: InstallSkillInput,
  dir: string = skillsDir(),
): Promise<{
  name: string;
  description: string;
  bytes: number;
  path: string;
}> {
  const text = input.url
    ? await fetchSkillText(input.url)
    : (input.content ?? "");
  if (!text.trim()) {
    throw new InstallError(
      400,
      "isi skill kosong — kasih link GitHub ke SKILL.md atau tempel isi SKILL.md-nya",
    );
  }
  if (text.length > MAX_SKILL_BYTES) {
    throw new InstallError(413, "file skill terlalu besar (maks 64 KB)");
  }
  const { name, description, category } = parseFrontmatter(text);
  if (!name || !description) {
    throw new InstallError(
      400,
      "SKILL.md butuh frontmatter --- dengan name dan description — lihat skills/website/website/SKILL.md sebagai contoh",
    );
  }
  if (!NAME_RE.test(name)) {
    throw new InstallError(
      400,
      `nama skill "${name}" tidak valid — hanya huruf kecil, angka, - dan _`,
    );
  }
  if (input.name && input.name !== name) {
    throw new InstallError(
      400,
      `nama yang diminta "${input.name}" tidak cocok dengan frontmatter name "${name}"`,
    );
  }
  const group = (CATEGORY_ORDER as readonly string[]).includes(category ?? "")
    ? category!
    : null;
  const skillDir = group ? join(dir, group, name) : join(dir, name);
  const relPath = group
    ? `skills/${group}/${name}/SKILL.md`
    : `skills/${name}/SKILL.md`;
  await mkdir(skillDir, { recursive: true });
  try {
    await writeFile(join(skillDir, "SKILL.md"), text, {
      flag: "wx",
      encoding: "utf8",
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new InstallError(
        409,
        `skill "${name}" sudah ada — hapus folder ${relPath.replace("/SKILL.md", "")} dulu lewat git kalau mau ganti`,
      );
    }
    throw err;
  }
  return {
    name,
    description,
    bytes: Buffer.byteLength(text, "utf8"),
    path: relPath,
  };
}
