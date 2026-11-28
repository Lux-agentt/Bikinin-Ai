// Renders a Remotion composition to MP4 (AGENTS.md Fase 3).
// Safety contract, enforced here (never trust the model for these):
// - Everything resolves inside the run workspace (resolveInWorkspace).
// - The composition is measured first (npx remotion compositions): duration
//   and resolution come from Remotion itself, not from the model's claims.
// - Duration <= BIKININ_MAX_VIDEO_SECONDS (default 30), resolution <= 1280x720.
// - A still frame is rendered and verified BEFORE the full render; a bad still
//   aborts the run, so a broken layout never costs a full render.
// - No shell: commands run via execFile with an argv array. Secrets are stripped
//   from the child environment (safeEnv), like run_command.
// - The output MP4 is verified with ffprobe (video stream + duration) when
//   ffprobe is available; otherwise a size check is used.
import { execFile } from "node:child_process";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AgentError } from "../errors.js";
import { pathExists, resolveInWorkspace } from "../safety/paths.js";
import { safeEnv } from "./run-command.js";
import { defineTool, truncate, type ToolContext, type ToolResult } from "./types.js";

export const REMOTION_VERSION = "4.0.544";
export const MAX_WIDTH = 1280;
export const MAX_HEIGHT = 720;
export const DEFAULT_MAX_VIDEO_SECONDS = 30;
const STILL_TIMEOUT_MS = 180_000;
const RENDER_TIMEOUT_MS = 600_000;
const COMPOSITIONS_TIMEOUT_MS = 180_000;
const MAX_BUFFER = 8 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function maxVideoSeconds(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(env.BIKININ_MAX_VIDEO_SECONDS);
  return Number.isInteger(raw) && raw > 0
    ? raw
    : DEFAULT_MAX_VIDEO_SECONDS;
}

export interface CompositionInfo {
  id: string;
  fps: number;
  width: number;
  height: number;
  frames: number;
  seconds: number;
}

/**
 * Parses the human table printed by `npx remotion compositions`:
 *   Intro    30      1280x720       300 (10.00 sec)
 * The --json flag does not produce JSON in 4.0.544, so the table is the source
 * of truth. Lines that do not match are ignored; an empty result fails closed.
 */
export function parseCompositionsTable(text: string): CompositionInfo[] {
  const out: CompositionInfo[] = [];
  const re =
    /^(\S+)\s+(\d+)\s+(\d+)x(\d+)\s+(\d+)\s+\(([\d.]+) sec\)\s*$/;
  for (const line of text.split("\n")) {
    const m = line.trim().match(re);
    if (!m) continue;
    const [, id, fps, width, height, frames, seconds] = m;
    out.push({
      id,
      fps: Number(fps),
      width: Number(width),
      height: Number(height),
      frames: Number(frames),
      seconds: Number(seconds),
    });
  }
  return out;
}

/** Returns the limit violation, or null when the composition is allowed. */
export function checkLimits(
  info: CompositionInfo,
  maxSeconds: number,
): string | null {
  if (info.seconds > maxSeconds)
    return (
      `durasi ${info.seconds} detik melebihi batas ${maxSeconds} detik ` +
      `(BIKININ_MAX_VIDEO_SECONDS). Pecah jadi beberapa video.`
    );
  if (info.width > MAX_WIDTH || info.height > MAX_HEIGHT)
    return (
      `resolusi ${info.width}x${info.height} melebihi batas ` +
      `${MAX_WIDTH}x${MAX_HEIGHT} (720p). Turunkan width/height komposisi.`
    );
  return null;
}

interface ExecResult {
  ok: boolean;
  killed: boolean;
  code: number;
  output: string;
}

type ExecFn = (
  file: string,
  args: string[],
  opts: { cwd: string; timeout: number; signal?: AbortSignal },
) => Promise<ExecResult>;

/** Diekspor untuk tes: spawn binary yang tidak ada harus terlihat di output. */
export function defaultExec(
  file: string,
  args: string[],
  opts: { cwd: string; timeout: number; signal?: AbortSignal },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeout,
        maxBuffer: MAX_BUFFER,
        // Stop membunuh proses render yang sedang jalan.
        signal: opts.signal,
        env: safeEnv(process.env),
      },
      (error, stdout, stderr) => {
        const code =
          typeof error?.code === "number" ? error.code : error ? 1 : 0;
        // Spawn gagal (mis. binary tidak ada: ENOENT) tidak menghasilkan
        // stdout/stderr sama sekali — tanpa baris ini, pemanggil tidak bisa
        // membedakan "binary tidak ada" dari "binary jalan tapi error tanpa
        // pesan" (bug 28 Nov 2026: ffprobe hilang di VPS dilaporkan sebagai
        // "ffprobe gagal memeriksa ...: " dengan pesan kosong, padahal
        // render-nya sudah berhasil).
        const spawnError =
          error && typeof error.code === "string"
            ? `[spawn error: ${error.code}]`
            : "";
        const output = [stdout, stderr ? `[stderr]\n${stderr}` : "", spawnError]
          .filter(Boolean)
          .join("\n");
        resolve({ ok: !error, killed: Boolean(error?.killed), code, output });
      },
    );
  });
}

function tailLines(text: string, n: number): string {
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prefers the project's own install (fast, exact version). Falls back to
 * npx downloading the pinned version when the project has no local Remotion.
 * Returns [file, prefixArgs] so the caller appends the subcommand.
 */
async function remotionCommand(
  projectAbs: string,
): Promise<{ file: string; prefix: string[] }> {
  const localBin = join(projectAbs, "node_modules", ".bin", "remotion");
  if (await fileExists(localBin)) return { file: localBin, prefix: [] };
  return {
    file: "npx",
    prefix: ["--yes", `remotion@${REMOTION_VERSION}`],
  };
}

interface FfprobeInfo {
  duration: number;
  hasVideo: boolean;
}

async function probeMp4(
  abs: string,
  exec: ExecFn,
  cwd: string,
): Promise<FfprobeInfo | null> {
  const r = await exec(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-show_entries",
      "stream=codec_type",
      "-of",
      "json",
      abs,
    ],
    { cwd, timeout: 60_000 },
  );
  if (!r.ok) {
    // ffprobe missing (exit 127 / ENOENT) is not fatal: the caller falls back
    // to a size check. A real ffprobe error on an existing file is fatal.
    // "spawn error" menandakan binary-nya gagal dijalankan sama sekali
    // (mis. tidak ada / tidak bisa dieksekusi) — perlakukan sama seperti
    // tidak ada, karena defaultExec menaruh kode spawn di output.
    if (/ENOENT|not found|127|spawn error/.test(r.output)) return null;
    throw new AgentError(
      "tool_failed",
      `ffprobe gagal memeriksa ${abs}: ${tailLines(r.output, 5)}`,
      true,
    );
  }
  try {
    const parsed = JSON.parse(r.output) as {
      format?: { duration?: string };
      streams?: Array<{ codec_type?: string }>;
    };
    return {
      duration: Number(parsed.format?.duration ?? NaN),
      hasVideo: (parsed.streams ?? []).some(
        (s) => s.codec_type === "video",
      ),
    };
  } catch {
    throw new AgentError(
      "tool_failed",
      "ffprobe mengeluarkan output yang tidak bisa dibaca",
      true,
    );
  }
}

export const renderVideoSchema = z.object({
  projectDir: z.string().min(1).default("."),
  compositionId: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "id komposisi tidak valid"),
  output: z
    .string()
    .min(1)
    .default("out/video.mp4")
    .refine((o) => o.toLowerCase().endsWith(".mp4"), "output harus .mp4"),
  frame: z.number().int().nonnegative().optional(),
});

type RenderVideoArgs = z.output<typeof renderVideoSchema>;

export async function executeRenderVideo(
  a: RenderVideoArgs,
  ctx: ToolContext,
  exec: ExecFn = defaultExec,
): Promise<ToolResult> {
  const maxSeconds = maxVideoSeconds();
  const { abs: projectAbs } = await resolveInWorkspace(
    ctx.workspace,
    a.projectDir,
  );
  const { abs: outputAbs, rel: outputRel } = await resolveInWorkspace(
    ctx.workspace,
    a.output,
  );
  const stillRel = outputRel.replace(/\.mp4$/i, ".still.png");
  const { abs: stillAbs } = await resolveInWorkspace(ctx.workspace, stillRel);

  if (!(await pathExists(join(projectAbs, "package.json"))))
    throw new AgentError(
      "tool_failed",
      `bukan project Remotion: ${a.projectDir} tidak punya package.json. ` +
        `Buat dulu dengan create-video atau npm install remotion (lihat skill remotion).`,
      true,
    );

  const { file: bin, prefix } = await remotionCommand(projectAbs);
  const run = (sub: string[], timeout: number): Promise<ExecResult> =>
    exec(bin, [...prefix, ...sub], {
      cwd: projectAbs,
      timeout,
      signal: ctx.signal,
    });

  // 1. Ukur komposisi dari Remotion sendiri (bukan dari klaim model).
  const comps = await run(["compositions"], COMPOSITIONS_TIMEOUT_MS);
  if (!comps.ok)
    throw new AgentError(
      "tool_failed",
      `npx remotion compositions gagal (exit ${comps.code}):\n${tailLines(comps.output, 10)}` +
        (comps.output.trim() === ""
          ? "\nOutput kosong — kemungkinan src/Root.tsx tidak mendaftarkan <Composition> sama sekali (Remotion menemukan 0 komposisi) atau bundle gagal sebelum mencetak error. Jalankan `npx remotion compositions` di terminal untuk melihat error aslinya; pastikan RemotionRoot me-render <Composition id=\"...\" component={...} ... />."
          : ""),
      true,
    );
  const found = parseCompositionsTable(comps.output).find(
    (c) => c.id === a.compositionId,
  );
  if (!found) {
    const ids = parseCompositionsTable(comps.output)
      .map((c) => c.id)
      .join(", ");
    throw new AgentError(
      "tool_failed",
      `komposisi "${a.compositionId}" tidak ditemukan` +
        (ids
          ? ` (yang ada: ${ids})`
          : " — tidak ada komposisi sama sekali yang terdaftar di src/Root.tsx") +
        `. Periksa id di src/Root.tsx.`,
      true,
    );
  }
  const violation = checkLimits(found, maxSeconds);
  if (violation)
    throw new AgentError("tool_failed", violation, true);

  // 2. Still dulu, di frame tengah (atau frame yang diminta). Gagal = berhenti.
  const frame = a.frame ?? Math.floor(found.frames / 2);
  if (frame >= found.frames)
    throw new AgentError(
      "tool_failed",
      `frame ${frame} di luar jangkauan (komposisi hanya ${found.frames} frame)`,
      true,
    );
  await mkdir(dirname(stillAbs), { recursive: true });
  const still = await run(
    ["still", a.compositionId, stillAbs, `--frame=${frame}`, "--image-format=png"],
    STILL_TIMEOUT_MS,
  );
  if (!still.ok)
    throw new AgentError(
      "tool_failed",
      `still frame ${frame} gagal (exit ${still.code}). Perbaiki dulu, jangan render penuh:\n${tailLines(still.output, 10)}`,
      true,
    );
  const stillBytes = await readFile(stillAbs);
  if (
    stillBytes.length < 1024 ||
    !stillBytes.subarray(0, 8).equals(PNG_SIGNATURE)
  )
    throw new AgentError(
      "tool_failed",
      `still ${stillRel} bukan PNG yang valid (${stillBytes.length} B). Perbaiki dulu, jangan render penuh.`,
      true,
    );

  // 3. Render penuh.
  await mkdir(dirname(outputAbs), { recursive: true });
  const existed = await pathExists(outputAbs);
  const render = await run(
    ["render", a.compositionId, outputAbs, "--overwrite"],
    RENDER_TIMEOUT_MS,
  );
  if (!render.ok)
    throw new AgentError(
      "tool_failed",
      render.killed
        ? "render timeout (600 detik). Video mungkin terlalu panjang/berat untuk mesin ini."
        : `render gagal (exit ${render.code}):\n${tailLines(render.output, 10)}`,
      true,
    );

  // 4. Verifikasi MP4.
  const { size } = await stat(outputAbs);
  const probe = await probeMp4(outputAbs, exec, projectAbs);
  let verifyNote: string;
  if (probe === null) {
    verifyNote = "ffprobe tidak tersedia, dicek ukuran file saja";
  } else {
    if (!probe.hasVideo)
      throw new AgentError(
        "tool_failed",
        "MP4 hasil render tidak punya video stream",
        true,
      );
    if (Number.isNaN(probe.duration) || Math.abs(probe.duration - found.seconds) > 0.6)
      throw new AgentError(
        "tool_failed",
        `durasi MP4 ${probe.duration} dtk tidak cocok dengan komposisi ${found.seconds} dtk`,
        true,
      );
    verifyNote = `ffprobe: ${probe.duration.toFixed(2)} dtk, ada video stream`;
  }
  const kb = (size / 1024).toFixed(1);
  return {
    ok: true,
    summary:
      `${outputRel} (${found.seconds} dtk, ${found.width}x${found.height}, ${kb} KB) — ` +
      `still frame ${frame} dicek dulu (${stillRel}), ${verifyNote}`,
    output:
      `Komposisi ${a.compositionId}: ${found.fps} fps, ${found.frames} frame, ` +
      `${found.width}x${found.height}.\n` +
      `Still: ${stillRel} (frame ${frame}, PNG valid).\n` +
      `Video: ${outputRel} (${kb} KB). ${verifyNote}.`,
    changes: [
      {
        path: outputRel,
        op: existed ? "modified" : "created",
        bytes: size,
      },
      {
        path: stillRel,
        op: "created",
        bytes: stillBytes.length,
      },
    ],
  };
}

export const renderVideoTool = defineTool({
  name: "render_video",
  description:
    "Render komposisi Remotion menjadi MP4. Selalu cek still frame dulu sebelum render penuh. Durasi maks BIKININ_MAX_VIDEO_SECONDS (default 30 dtk), resolusi maks 1280x720. Argumen: compositionId (wajib), projectDir (default '.'), output (default out/video.mp4), frame (opsional, default tengah).",
  parameters: {
    type: "object",
    properties: {
      projectDir: {
        type: "string",
        description: "Folder project Remotion di dalam workspace (default '.')",
      },
      compositionId: {
        type: "string",
        description: "Id komposisi di src/Root.tsx, mis. Intro",
      },
      output: {
        type: "string",
        description: "Path MP4 hasil render di dalam workspace (default out/video.mp4)",
      },
      frame: {
        type: "number",
        description: "Frame yang dicek sebagai still (default frame tengah)",
      },
    },
    required: ["compositionId"],
    additionalProperties: false,
  },
  readOnly: false,
  schema: renderVideoSchema,
  label: (a) => `render_video ${a.compositionId} → ${a.output}`,
  publicArgs: (a) => ({
    projectDir: a.projectDir,
    compositionId: a.compositionId,
    output: a.output,
    ...(a.frame !== undefined ? { frame: a.frame } : {}),
  }),
  async run(a, ctx) {
    return executeRenderVideo(a, ctx);
  },
});
