// Self-check (Fase 6, Track A): the agent verifies its own result before
// declaring the run finished. Runs as plain code, never as a model call:
// it re-reads the files the run changed, scans for placeholder text, checks
// full HTML pages for real CSS (no default-browser look), and runs the
// project's own check command (test/build/lint from package.json scripts)
// when one exists. Only allowlisted commands run, with a timeout and capped
// output. Findings go back to the model for at most
// SELF_CHECK_MAX_FIX_ROUNDS fix rounds; the loop enforces that budget.
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { posix } from "node:path";
import { classifyCommand } from "../safety/commands.js";
import { resolveInWorkspace } from "../safety/paths.js";
import { safeEnv } from "../tools/run-command.js";

/** Max fix rounds the loop gives the model after a failed self-check.
 * 1 putaran saja (dulu 2): putaran kedua jarang memperbaiki apa pun tapi
 * selalu menambah 10-40 detik — model gratis lambat, jadi tiap putaran
 * perbaikan terasa (aturan user 2026-11-28: kerjaan harus to the point). */
export const SELF_CHECK_MAX_FIX_ROUNDS = 1;
/** One check command gets at most 60 detik; the run's own budget still applies. */
export const SELF_CHECK_TIMEOUT_MS = 60_000;
const MAX_FILE_BYTES = 500_000;
const MAX_DETAIL_CHARS = 300;
/** Placeholder text that means the work is not really finished. */
const PLACEHOLDER_RE = /\bTODO\b|\bFIXME\b|lorem ipsum/i;
/** A file is a full HTML page (not a fragment) when it has a doctype or <html>. */
const HTML_PAGE_RE = /<!doctype html|<html[\s>]/i;
const STYLE_BLOCK_RE = /<style[^>]*>([\s\S]*?)<\/style>/gi;
const STYLESHEET_LINK_RE =
  /<link[^>]*rel=["']?stylesheet["']?[^>]*>/i;
const HREF_RE = /href=["']([^"']+)["']/i;
const FONT_RE = /font-family\s*:/i;
const COLOR_RE = /#[0-9a-f]{3,8}\b|rgba?\s*\(|hsla?\s*\(/i;
const NAV_BLOCK_RE = /<nav\b[^>]*>([\s\S]*?)<\/nav>/gi;
const UL_TAG_RE = /<ul\b[^>]*>/gi;

/** Collects the CSS of a full HTML page: inline <style> blocks, or the
 * linked stylesheet when it is one of the files this run changed. Returns
 * null when the CSS cannot be inspected in this run (external file that
 * was not changed) — the caller then skips the content check, it does not
 * fail it. */
function collectPageCss(
  rel: string,
  text: string,
  contents: Map<string, string>,
): string | null {
  const blocks: string[] = [];
  for (const m of text.matchAll(STYLE_BLOCK_RE)) blocks.push(m[1]);
  if (blocks.length > 0) return blocks.join("\n");
  const link = STYLESHEET_LINK_RE.exec(text);
  if (!link) return "";
  const href = HREF_RE.exec(link[0])?.[1]?.split(/[?#]/)[0] ?? "";
  if (!href) return "";
  const clean = href.replace(/^\.\//, "").replace(/^\//, "");
  const candidates = [
    clean,
    posix.normalize(posix.join(posix.dirname(rel), clean)),
  ];
  for (const c of candidates) {
    const css = contents.get(c);
    if (css !== undefined) return css;
  }
  return null;
}

/**
 * Visual minimum for a full HTML page (skill website, "CSS wajib"):
 * real CSS must exist, it must declare a font and a color, and a nav must
 * not be a bare bullet list. Fragments (no doctype/<html>) are skipped.
 */
function checkHtmlStyling(
  rel: string,
  text: string,
  contents: Map<string, string>,
): SelfCheckItem[] {
  const out: SelfCheckItem[] = [];
  if (!rel.toLowerCase().endsWith(".html") || !HTML_PAGE_RE.test(text))
    return out;
  const hasStyle = /<style[\s>]/i.test(text) || STYLESHEET_LINK_RE.test(text);
  out.push({
    name: `tampilan ${rel}`,
    ok: hasStyle,
    detail: hasStyle
      ? "halaman punya CSS"
      : "halaman HTML tanpa CSS nyata — tambahkan <style> atau file CSS (skill website: CSS minimal wajib)",
  });
  // Tanpa CSS sama sekali, cek isi CSS sudah diwakili cek tampilan di atas.
  if (hasStyle) {
    const css = collectPageCss(rel, text, contents);
    if (css === null) {
      out.push({
        name: `css ${rel}`,
        ok: true,
        detail: "stylesheet eksternal, tidak diperiksa di run ini",
      });
    } else if (css === "") {
      out.push({
        name: `css ${rel}`,
        ok: false,
        detail:
          "blok <style> kosong — isi dengan CSS nyata (skill website: CSS minimal wajib)",
      });
    } else {
      const missing: string[] = [];
      if (!FONT_RE.test(css)) missing.push("font-family");
      if (!COLOR_RE.test(css)) missing.push("warna");
      out.push({
        name: `css ${rel}`,
        ok: missing.length === 0,
        detail:
          missing.length === 0
            ? "CSS mendeklarasikan font dan warna"
            : `CSS tidak mendeklarasikan ${missing.join(" dan ")} — tambahkan ke CSS (skill website: CSS minimal wajib)`,
      });
    }
  }
  let bareNav = false;
  for (const nav of text.matchAll(NAV_BLOCK_RE)) {
    for (const ul of nav[1].matchAll(UL_TAG_RE)) {
      if (!/class\s*=/.test(ul[0])) bareNav = true;
    }
  }
  out.push({
    name: `nav ${rel}`,
    ok: !bareNav,
    detail: bareNav
      ? "nav masih bullet list polos — beri class pada <ul> di dalam <nav> dan tata dengan display:flex (skill website: CSS minimal wajib)"
      : "nav bukan bullet list polos",
  });
  return out;
}

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

  // 2b. Full HTML pages must ship real CSS (skill website, "CSS wajib"):
  // no default-browser look (Times serif, blue links, bare bullet nav).
  for (const [rel, text] of contents) {
    checks.push(...checkHtmlStyling(rel, text, contents));
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
