// inspect_image tool: path guard, image/size validation, and plumbing of
// ctx.describeImage (injected fake — the real wiring lives in the loop).
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { VisionRequest, VisionResult } from "../src/llm/client.js";
import {
  DEFAULT_INSPECT_PROMPT,
  INSPECT_IMAGE_MAX_BYTES,
  inspectImageTool,
} from "../src/tools/inspect-image.js";
import { OUTPUT_LIMIT } from "../src/tools/types.js";
import { tempWorkspace } from "./helpers.js";

// 1x1 transparent PNG.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);

function fakeDescribe(
  seen: VisionRequest[],
  text = "Screenshot halaman login: tombol biru di kanan bawah.",
): (req: VisionRequest) => Promise<VisionResult> {
  return async (req) => {
    seen.push(req);
    return { text, model: "gemini-4-hydrogen", provider: "gemini" };
  };
}

async function execute(
  raw: unknown,
  workspace: string,
  describeImage?: (req: VisionRequest) => Promise<VisionResult>,
) {
  const parsed = inspectImageTool.parse(raw);
  if (!parsed.ok) throw new Error(`argumen tidak valid: ${parsed.error}`);
  return parsed.execute({ workspace, describeImage });
}

describe("inspect_image", () => {
  it("describes a PNG via ctx.describeImage with the default prompt", async () => {
    const ws = await tempWorkspace();
    await writeFile(join(ws, "shot.png"), PNG_1X1);
    const seen: VisionRequest[] = [];
    const r = await execute({ path: "shot.png" }, ws, fakeDescribe(seen));
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("shot.png");
    expect(r.summary).toContain("gemini-4-hydrogen");
    expect(r.output).toContain("halaman login");
    expect(r.changes).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0].mime).toBe("image/png");
    expect(seen[0].prompt).toBe(DEFAULT_INSPECT_PROMPT);
    expect(seen[0].imageBase64).toBe(PNG_1X1.toString("base64"));
  });

  it("passes a custom prompt and accepts .jpg/.jpeg/.webp", async () => {
    const ws = await tempWorkspace();
    await writeFile(join(ws, "a.jpg"), PNG_1X1);
    await writeFile(join(ws, "b.webp"), PNG_1X1);
    const seen: VisionRequest[] = [];
    await execute(
      { path: "a.jpg", prompt: "Ada tombol apa saja?" },
      ws,
      fakeDescribe(seen),
    );
    expect(seen[0].mime).toBe("image/jpeg");
    expect(seen[0].prompt).toBe("Ada tombol apa saja?");
    const r = await execute({ path: "b.webp" }, ws, fakeDescribe(seen));
    expect(r.ok).toBe(true);
    expect(seen[1].mime).toBe("image/webp");
  });

  it("blocks paths outside the workspace", async () => {
    const ws = await tempWorkspace();
    await expect(
      execute({ path: "../rahasia.png" }, ws, fakeDescribe([])),
    ).rejects.toThrow("path keluar dari workspace");
    await expect(
      execute({ path: "/etc/passwd.png" }, ws, fakeDescribe([])),
    ).rejects.toThrow("path absolut tidak diizinkan");
  });

  it("rejects a missing file", async () => {
    const ws = await tempWorkspace();
    await expect(
      execute({ path: "tidak-ada.png" }, ws, fakeDescribe([])),
    ).rejects.toThrow("tidak ditemukan di workspace");
  });

  it("rejects a non-image extension", async () => {
    const ws = await tempWorkspace();
    await writeFile(join(ws, "notes.txt"), "halo");
    await expect(
      execute({ path: "notes.txt" }, ws, fakeDescribe([])),
    ).rejects.toThrow("bukan gambar");
  });

  it("rejects a file over 2 MB instead of downscaling it", async () => {
    const ws = await tempWorkspace();
    await writeFile(
      join(ws, "besar.png"),
      Buffer.alloc(INSPECT_IMAGE_MAX_BYTES + 1),
    );
    await expect(
      execute({ path: "besar.png" }, ws, fakeDescribe([])),
    ).rejects.toThrow("terlalu besar");
  });

  it("says so clearly when vision is not wired into this run", async () => {
    const ws = await tempWorkspace();
    await writeFile(join(ws, "shot.png"), PNG_1X1);
    await expect(execute({ path: "shot.png" }, ws)).rejects.toThrow(
      "vision belum tersedia di run ini",
    );
  });

  it("caps long descriptions at the output limit", async () => {
    const ws = await tempWorkspace();
    await writeFile(join(ws, "shot.png"), PNG_1X1);
    const long = "x".repeat(OUTPUT_LIMIT + 500);
    const r = await execute({ path: "shot.png" }, ws, fakeDescribe([], long));
    expect(r.output.length).toBeLessThanOrEqual(OUTPUT_LIMIT + 100);
    expect(r.output).toContain("[dipotong:");
  });
});
