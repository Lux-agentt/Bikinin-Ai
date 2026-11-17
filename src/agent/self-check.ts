// Self-check (Fase 6, Track A): the agent verifies its own result before
// declaring the run finished. Runs as plain code, never as a model call:
// it re-reads the files the run changed, scans for placeholder text, and
// runs the project's own check command (test/build/lint from package.json
// scripts) when one exists. Only allowlisted commands run, with a timeout
// and capped output. Findings go back to the model for at most
// SELF_CHECK_MAX_FIX_ROUNDS fix rounds; the loop enforces that budget.
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { classifyCommand } from "../safety/commands.js";
import { resolveInWorkspace } from "../safety/paths.js";
import { safeEnv } from "../tools/run-command.js";

/** Max fix rounds the loop gives the model after a failed self-check. */
export const SELF_CHECK_MAX_FIX_ROUNDS = 2;
/** One check command gets at most 60 detik; the run's own budget still applies. */
export const SELF_CHECK_TIMEOUT_MS = 60_000;
const MAX_FILE_BYTES = 500_000;
const MAX_DETAIL_CHARS = 300;
/** Placeholder text that means the work is not really finished. */
const PLACEHOLDER_RE = /\bTODO\b|\bFIXME\b|lorem ipsum/i;

export interface SelfCheckItem {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SelfCheckResult {
  outcome: "pass" | "fail";
  checks: SelfCheckItem[];
}

export interface SelfCheckInput {
  workspace: string; // absolute realpath
  /** The run's changed files (created/modified only; deleted files are skipped). */
  files: string[]; // relative paths
  /** The model's final answer text (for non-code tasks). */
  finalText: string;
}

function short(text: string, max = MAX_DETAIL_CHARS): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function runNpm(
  workspace: string,
  args: string[],
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      "npm",
      args,
      {
        cwd: workspace,
        timeout: SELF_CHECK_TIMEOUT_MS,
        maxBuffer: 512 * 1024,
        env: safeEnv(process.env),
      },
      (error, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join("\n");
        resolve({
          ok: !error,
          output: error?.killed
            ? `timeout (${SELF_CHECK_TIMEOUT_MS / 1000} dtk)`
            : output,
        });
      },
    );
  });
}

/**
 * Picks the project's own check command from package.json scripts, in
 * priority order test > build > lint. Returns null when there is no
 * package.json, no usable script, or the command is not allowlisted.
 */
export async function pickCheckCommand(
  workspace: string,
): Promise<{ label: string; npmArgs: string[] } | null> {
  let pkg: { scripts?: Record<string, unknown> };
  try {
    const { abs } = await resolveInWorkspace(workspace, "package.json");
    pkg = JSON.parse(await readFile(abs, "utf8")) as typeof pkg;
  } catch {
    return null; // no package.json, unreadable, or invalid JSON: no command check
  }
  const scripts = pkg.scripts ?? {};
  const pick =
    typeof scripts.test === "string"
      ? { label: "npm test", npmArgs: ["test"] }
      : typeof scripts.build === "string"
        ? { label: "npm run build", npmArgs: ["run", "build"] }
        : typeof scripts.lint === "string"
          ? { label: "npm run lint", npmArgs: ["run", "lint"] }
          : null;
  if (!pick) return null;
  // Defense in depth: only run the command if the policy allows it as-is.
  if (classifyCommand(pick.label).decision !== "allow") return null;
  return pick;
}

export async function runSelfCheck(
  input: SelfCheckInput,
): Promise<SelfCheckResult> {
  const checks: SelfCheckItem[] = [];

  // 1. Every changed file exists, is readable, and is not empty.
  const contents = new Map<string, string>();
  for (const rel of input.files) {
    try {
      const { abs } = await resolveInWorkspace(input.workspace, rel);
      const st = await stat(abs);
      if (!st.isFile()) {
        checks.push({
          name: `file ${rel}`,
          ok: false,
          detail: "bukan file",
        });
        continue;
      }
      if (st.size === 0) {
        checks.push({ name: `file ${rel}`, ok: false, detail: "file kosong" });
        continue;
      }
      if (st.size > MAX_FILE_BYTES) {
        checks.push({
          name: `file ${rel}`,
          ok: false,
          detail: `file terlalu besar untuk dibaca ulang (${st.size} B)`,
        });
        continue;
      }
      const text = await readFile(abs, "utf8");
      contents.set(rel, text);
      checks.push({
        name: `file ${rel}`,
        ok: true,
        detail: `${st.size} B, terbaca`,
      });
    } catch (err) {
      checks.push({
        name: `file ${rel}`,
        ok: false,
        detail: `tidak bisa dibaca: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // 2. No placeholder text left in the changed files.
  for (const [rel, text] of contents) {
    const m = PLACEHOLDER_RE.exec(text);
    checks.push({
      name: `placeholder ${rel}`,
      ok: !m,
      detail: m
        ? `masih ada placeholder: "${m[0]}"`
        : "tidak ada TODO/FIXME/lorem ipsum",
    });
  }

  // 3. The project's own check command, when one exists.
  const cmd = await pickCheckCommand(input.workspace);
  if (cmd) {
    const r = await runNpm(input.workspace, cmd.npmArgs);
    const tail = short(r.output.split("\n").filter(Boolean).pop() ?? "");
    checks.push({
      name: `perintah ${cmd.label}`,
      ok: r.ok,
      detail: r.ok
        ? `exit 0${tail ? `: ${tail}` : ""}`
        : `gagal${r.output ? `: ${short(r.output)}` : ""}`,
    });
  }

  // 4. Non-code tasks (no files changed): the answer itself must exist.
  // Code tasks get this too — an empty final answer is never a finish.
  checks.push({
    name: "jawaban",
    ok: input.finalText.trim().length > 0,
    detail:
      input.finalText.trim().length > 0
        ? `jawaban akhir ${input.finalText.trim().length} karakter`
        : "jawaban akhir kosong",
  });

  return {
    outcome: checks.every((c) => c.ok) ? "pass" : "fail",
    checks,
  };
}

/** The message sent back to the model when verification fails. */
export function formatSelfCheckFeedback(
  result: SelfCheckResult,
  round: number,
): string {
  const failed = result.checks.filter((c) => !c.ok);
  return (
    `Verifikasi sendiri (putaran ${round}/${SELF_CHECK_MAX_FIX_ROUNDS}) menemukan masalah — perbaiki sebelum menyatakan selesai:\n` +
    failed.map((c) => `- ${c.name}: ${c.detail}`).join("\n") +
    `\nPerbaiki dengan tool yang sesuai, lalu jawab lagi. Jangan mengulang cara yang sama bila sudah gagal.`
  );
}
