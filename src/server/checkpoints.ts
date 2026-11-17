// Checkpoints (Fase 5, ala Claude Code rewind): snapshot the workspace at
// the start of a run, restore only on the user's explicit action.
//
// Two methods, git first:
//  - git: the whole working tree is captured as a commit object via a TEMP
//    index (GIT_INDEX_FILE), so the real index and working tree are never
//    touched. Restore uses `git restore --source=<commit> --worktree -- .`.
//  - copy: when the workspace is not a git repo (or git fails), files are
//    copied to workspace/.bikinin/checkpoints/<id>/.
//
// Safety: secrets are never snapshotted (.env, *.pem, *credentials*,
// *secret* are excluded from both methods), and restore never deletes
// them either. Restore only deletes workspace files that are not in the
// snapshot AND not excluded — .bikinin, .git and node_modules are never
// touched.
import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";

export const MAX_CHECKPOINTS = 10;
const MAX_COPY_FILE_BYTES = 5 * 1024 * 1024;
const MAX_COPY_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 1000;
const ID_RE = /^cp_[a-f0-9]{8}$/;

const SKIP_DIRS = new Set([".git", ".bikinin", "node_modules"]);
const EXCLUDED_FILE = /(^|\/)\.env(\.|$)|(^|\/)[^/]*credentials[^/]*$|(^|\/)[^/]*secret[^/]*$|\.pem$/i;

export interface CheckpointMeta {
  id: string;
  created_at: string;
  session_id: string;
  run_id: string;
  method: "git" | "copy";
  git_commit?: string;
  files: string[]; // relative, posix
  bytes: number;
}

export function checkpointsDir(workspace: string): string {
  return join(workspace, ".bikinin", "checkpoints");
}

function metaPath(workspace: string, id: string): string {
  return join(checkpointsDir(workspace), `${id}.json`);
}

function isExcluded(rel: string): boolean {
  return EXCLUDED_FILE.test(rel);
}

async function walkFiles(
  workspace: string,
  dir: string,
): Promise<Array<{ rel: string; abs: string; bytes: number }>> {
  const out: Array<{ rel: string; abs: string; bytes: number }> = [];
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      // Dotfiles/dotdirs (.git, .bikinin, .env, .DS_Store…) are never
      // project output: never snapshotted, never deleted on restore.
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
      const abs = join(d, e.name);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        const rel = relative(workspace, abs).split(sep).join("/");
        if (isExcluded(rel)) continue;
        const st = await stat(abs).catch(() => null);
        if (!st) continue;
        out.push({ rel, abs, bytes: st.size });
      }
      if (out.length >= MAX_FILES) return;
    }
  };
  await walk(dir);
  return out;
}

function git(
  workspace: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd: workspace, timeout: timeoutMs, env: { ...process.env, ...env } },
      (err, stdout) => {
        if (err) reject(new Error(`git ${args[0]} gagal: ${err.message}`));
        else resolve(stdout.toString().trim());
      },
    );
  });
}

async function snapshotWithGit(
  workspace: string,
  id: string,
  files: Array<{ rel: string; abs: string; bytes: number }>,
): Promise<string> {
  const tmpIndex = join(tmpdir(), `bikinin-index-${id}`);
  const env = {
    GIT_INDEX_FILE: tmpIndex,
    GIT_AUTHOR_NAME: "Bikinin AI",
    GIT_AUTHOR_EMAIL: "bikinin@localhost",
    GIT_COMMITTER_NAME: "Bikinin AI",
    GIT_COMMITTER_EMAIL: "bikinin@localhost",
  };
  try {
    // Empty temp index + add the whole tree (respects .gitignore).
    await git(workspace, ["read-tree", "--empty"], env, 10_000);
    await git(workspace, ["add", "-A", "--", "."], env, 15_000);
    // Belt and braces: .env and friends must never land in the object,
    // even when the project has no .gitignore for them.
    await git(
      workspace,
      ["rm", "--cached", "--quiet", "--ignore-unmatch", "--", ".env", ".env.*", "*.pem", "*credentials*", "*secret*"],
      env,
      10_000,
    );
    const tree = await git(workspace, ["write-tree"], env, 10_000);
    const commit = await git(
      workspace,
      ["commit-tree", tree, "-m", `bikinin checkpoint ${id}`],
      env,
      10_000,
    );
    return commit;
  } finally {
    await rm(tmpIndex, { force: true }).catch(() => {});
  }
}

async function snapshotWithCopy(
  workspace: string,
  id: string,
  files: Array<{ rel: string; abs: string; bytes: number }>,
): Promise<{ files: string[]; bytes: number }> {
  const dest = join(checkpointsDir(workspace), id);
  await mkdir(dest, { recursive: true });
  let total = 0;
  const kept: string[] = [];
  for (const f of files) {
    if (f.bytes > MAX_COPY_FILE_BYTES) continue;
    if (total + f.bytes > MAX_COPY_TOTAL_BYTES) break;
    await mkdir(join(dest, f.rel, ".."), { recursive: true });
    await cp(f.abs, join(dest, f.rel));
    kept.push(f.rel);
    total += f.bytes;
  }
  return { files: kept, bytes: total };
}

async function pruneOld(workspace: string): Promise<void> {
  const list = await listCheckpoints(workspace);
  for (const old of list.slice(MAX_CHECKPOINTS)) {
    await rm(metaPath(workspace, old.id), { force: true }).catch(() => {});
    await rm(join(checkpointsDir(workspace), old.id), {
      recursive: true,
      force: true,
    }).catch(() => {});
  }
}

export async function createCheckpoint(
  workspace: string,
  sessionId: string,
  runId: string,
): Promise<CheckpointMeta> {
  const id = `cp_${randomUUID().slice(0, 8)}`;
  const created_at = new Date().toISOString();
  await mkdir(checkpointsDir(workspace), { recursive: true });
  const files = await walkFiles(workspace, workspace);
  let meta: CheckpointMeta;
  try {
    const gitDir = await stat(join(workspace, ".git")).catch(() => null);
    if (gitDir?.isDirectory()) {
      const commit = await snapshotWithGit(workspace, id, files);
      const listed = await git(
        workspace,
        ["ls-tree", "-r", "--name-only", commit],
        {},
        10_000,
      );
      meta = {
        id,
        created_at,
        session_id: sessionId,
        run_id: runId,
        method: "git",
        git_commit: commit,
        files: listed ? listed.split("\n").filter(Boolean) : [],
        bytes: files.reduce((n, f) => n + f.bytes, 0),
      };
    } else {
      throw new Error("bukan repo git");
    }
  } catch {
    // Not a git repo, or git failed: fall back to a file copy.
    const copied = await snapshotWithCopy(workspace, id, files);
    meta = {
      id,
      created_at,
      session_id: sessionId,
      run_id: runId,
      method: "copy",
      files: copied.files,
      bytes: copied.bytes,
    };
  }
  await writeFile(
    metaPath(workspace, id),
    JSON.stringify(meta, null, 2),
    "utf8",
  );
  await pruneOld(workspace).catch(() => {});
  return meta;
}

export async function listCheckpoints(
  workspace: string,
): Promise<CheckpointMeta[]> {
  let names: string[];
  try {
    names = await readdir(checkpointsDir(workspace));
  } catch {
    return [];
  }
  const out: CheckpointMeta[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const meta = JSON.parse(
        await readFile(join(checkpointsDir(workspace), name), "utf8"),
      ) as CheckpointMeta;
      if (meta && ID_RE.test(meta.id) && Array.isArray(meta.files))
        out.push(meta);
    } catch {
      // skip unreadable meta files
    }
  }
  return out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

/** Deletes workspace files that are not in the snapshot. Never touches
 *  .git, .bikinin, node_modules, or excluded (secret-like) files. */
async function deleteExtraFiles(
  workspace: string,
  keep: Set<string>,
): Promise<void> {
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(abs);
        // Remove the directory if it is now empty (best effort).
        await readdir(abs).then((rest) => {
          if (rest.length === 0) return rm(abs, { recursive: true, force: true });
        }).catch(() => {});
      } else if (e.isFile()) {
        const rel = relative(workspace, abs).split(sep).join("/");
        if (keep.has(rel) || isExcluded(rel)) continue;
        await rm(abs, { force: true }).catch(() => {});
      }
    }
  };
  await walk(workspace);
}

export async function restoreCheckpoint(
  workspace: string,
  id: string,
): Promise<{ files_restored: number; method: "git" | "copy" }> {
  if (!ID_RE.test(id)) throw new Error(`checkpoint tidak valid: ${id}`);
  let meta: CheckpointMeta;
  try {
    meta = JSON.parse(
      await readFile(metaPath(workspace, id), "utf8"),
    ) as CheckpointMeta;
  } catch {
    throw new Error(`checkpoint tidak ditemukan: ${id}`);
  }
  if (meta.id !== id || !Array.isArray(meta.files))
    throw new Error(`checkpoint rusak: ${id}`);
  const keep = new Set(meta.files);
  if (meta.method === "git" && meta.git_commit) {
    await git(
      workspace,
      ["restore", `--source=${meta.git_commit}`, "--worktree", "--", "."],
      {},
      30_000,
    );
    await deleteExtraFiles(workspace, keep);
  } else if (meta.method === "copy") {
    const src = join(checkpointsDir(workspace), id);
    await deleteExtraFiles(workspace, keep);
    for (const rel of meta.files) {
      const from = join(src, rel);
      const to = join(workspace, rel);
      await mkdir(join(to, ".."), { recursive: true });
      await cp(from, to).catch(() => {});
    }
  } else {
    throw new Error(`checkpoint tidak bisa dipulihkan: ${id}`);
  }
  return { files_restored: meta.files.length, method: meta.method };
}
