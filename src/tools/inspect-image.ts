// Vision (Fase 6): send a workspace image to a model that supports image
// input and return its description. The image bytes go through the fallback
// LLM client wired into ToolContext — this tool never builds its own client,
// never downscales (no image library is available), and never pretends to
// see when vision is unavailable.
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { z } from "zod";
import { AgentError } from "../errors.js";
import type { VisionRequest } from "../llm/client.js";
import { resolveInWorkspace } from "../safety/paths.js";
import { defineTool, truncate } from "./types.js";

/** Max image size: 2 MB. Larger files are rejected, never downscaled silently. */
export const INSPECT_IMAGE_MAX_BYTES = 2_000_000;

export const DEFAULT_INSPECT_PROMPT =
  "Deskripsikan screenshot ini — apa yang terlihat, ada masalah tampilan/bug?";

const IMAGE_MIME: Record<string, VisionRequest["mime"]> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export const inspectImageTool = defineTool({
  name: "inspect_image",
  description:
    "Lihat gambar (screenshot PNG/JPG/WebP, maks 2 MB) di workspace dan deskripsikan isinya: apa yang terlihat dan apakah ada masalah tampilan/bug. Hanya untuk file gambar di dalam workspace.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path gambar, relatif ke workspace",
      },
      prompt: {
        type: "string",
        description:
          "Pertanyaan tentang gambar. Default: deskripsikan screenshot ini",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  readOnly: true,
  schema: z.object({
    path: z.string().min(1),
    prompt: z.string().min(1).max(2000).default(DEFAULT_INSPECT_PROMPT),
  }),
  label: (a) => `inspect_image ${a.path}`,
  publicArgs: (a) => ({ path: a.path }),
  async run(a, ctx) {
    const { abs, rel } = await resolveInWorkspace(ctx.workspace, a.path);
    const mime = IMAGE_MIME[extname(rel).toLowerCase()];
    if (!mime) {
      throw new AgentError(
        "tool_failed",
        `${rel} bukan gambar (ekstensi harus .png, .jpg, atau .webp)`,
      );
    }
    let st;
    try {
      st = await stat(abs);
    } catch {
      throw new AgentError(
        "tool_failed",
        `${rel} tidak ditemukan di workspace`,
      );
    }
    if (!st.isFile()) throw new AgentError("tool_failed", `${rel} bukan file`);
    if (st.size > INSPECT_IMAGE_MAX_BYTES) {
      throw new AgentError(
        "tool_failed",
        `${rel} terlalu besar (${st.size} B, maks 2 MB) — kecilkan gambarnya dulu (resize/kompres), lalu coba lagi`,
      );
    }
    if (!ctx.describeImage) {
      throw new AgentError(
        "tool_failed",
        "vision belum tersedia di run ini (describeImage belum dikabel ke ToolContext)",
      );
    }
    const imageBase64 = (await readFile(abs)).toString("base64");
    const result = await ctx.describeImage({
      imageBase64,
      mime,
      prompt: a.prompt,
    });
    const { text } = truncate(result.text);
    return {
      ok: true,
      summary: `${rel} dilihat oleh ${result.model}${result.provider ? ` (${result.provider})` : ""}`,
      output: text,
      changes: [],
      // The loop adds vision tokens to the run totals (Fase 6 wiring).
      ...(result.usage ? { usage: result.usage } : {}),
    };
  },
});
