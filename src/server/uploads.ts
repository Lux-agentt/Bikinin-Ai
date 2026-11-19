// File uploads for the web UI (POST /api/uploads). No new dependency:
// a small bounded multipart/form-data parser over raw Buffers, so binary
// bytes survive intact. Files land in workspace/uploads/ where the agent's
// file tools can read them, and the UI passes their workspace-relative
// paths back as StartRunBody attachment_ids.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { isSecretPath, resolveInWorkspace } from "../safety/paths.js";

export const MAX_UPLOAD_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_UPLOAD_FILES = 6;
export const UPLOAD_DIR = "uploads";

export class UploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface SavedUpload {
  /** Workspace-relative path, e.g. uploads/ab12cd34_foto.jpg. */
  path: string;
  name: string;
  bytes: number;
}

interface Part {
  filename: string;
  data: Buffer;
}

/** Filename the user sent, reduced to one safe basename. */
export function sanitizeFilename(raw: string): string {
  const base = basename(raw.replace(/\\/g, "/")).trim();
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return cleaned === "" ? "file" : cleaned;
}

function parseBoundary(contentType: string | undefined): string {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? "");
  const boundary = (m?.[1] ?? m?.[2] ?? "").trim();
  if (!boundary) throw new UploadError(400, "multipart tanpa boundary");
  return boundary;
}

/**
 * Minimal multipart/form-data parser. Only parts with a filename are kept
 * (field name "file"); anything else is ignored. Throws UploadError 413
 * when a file or the whole body exceeds the caps.
 */
export function parseMultipart(body: Buffer, contentType: string): Part[] {
  const boundary = Buffer.from(`--${parseBoundary(contentType)}`);
  const parts: Part[] = [];
  let total = 0;
  let cursor = 0;
  for (;;) {
    const start = body.indexOf(boundary, cursor);
    if (start === -1) break;
    let i = start + boundary.length;
    // Final boundary ends with "--".
    if (body[i] === 0x2d && body[i + 1] === 0x2d) break;
    // Skip the CRLF after the boundary.
    if (body[i] === 0x0d && body[i + 1] === 0x0a) i += 2;
    else if (body[i] === 0x0a) i += 1;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), i);
    if (headerEnd === -1)
      throw new UploadError(400, "multipart tidak valid");
    const headers = body.subarray(i, headerEnd).toString("latin1");
    const dataStart = headerEnd + 4;
    const next = body.indexOf(boundary, dataStart);
    if (next === -1) throw new UploadError(400, "multipart tidak valid");
    // Part data ends with the CRLF before the next boundary.
    let dataEnd = next;
    if (body[dataEnd - 2] === 0x0d && body[dataEnd - 1] === 0x0a)
      dataEnd -= 2;
    const disp = /Content-Disposition:[^\r\n]*/i.exec(headers)?.[0] ?? "";
    const name = /name="([^"]*)"/i.exec(disp)?.[1] ?? "";
    const filename = /filename="([^"]*)"/i.exec(disp)?.[1];
    if (name === "file" && filename !== undefined && filename !== "") {
      const data = body.subarray(dataStart, dataEnd);
      if (data.length > MAX_UPLOAD_FILE_BYTES)
        throw new UploadError(
          413,
          `file melebihi batas ${MAX_UPLOAD_FILE_BYTES / 1024 / 1024} MB`,
        );
      total += data.length;
      if (total > MAX_UPLOAD_TOTAL_BYTES)
        throw new UploadError(413, "total upload melebihi batas 20 MB");
      parts.push({ filename, data: Buffer.from(data) });
      if (parts.length > MAX_UPLOAD_FILES)
        throw new UploadError(413, "maksimal 6 file per upload");
    }
    cursor = next;
  }
  return parts;
}

async function readBody(
  req: { [Symbol.asyncIterator](): AsyncIterator<Buffer> },
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes)
      throw new UploadError(413, "total upload melebihi batas 20 MB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Reads a multipart upload request and stores every file under
 * workspace/uploads/. The stored name gets a random prefix, so an
 * uploaded ".env" can never land on a secret path — and names that still
 * trip the secret-file rule (e.g. "*secret*") are rejected outright.
 */
export async function saveUploads(
  req: { headers: Record<string, string | string[] | undefined>; [Symbol.asyncIterator](): AsyncIterator<Buffer> },
  workspace: string,
): Promise<SavedUpload[]> {
  const contentType = req.headers["content-type"];
  const body = await readBody(req, MAX_UPLOAD_TOTAL_BYTES + 64 * 1024);
  const parts = parseMultipart(
    body,
    Array.isArray(contentType) ? contentType[0] ?? "" : (contentType ?? ""),
  );
  if (parts.length === 0)
    throw new UploadError(400, "tidak ada file yang diunggah");
  const dir = (await resolveInWorkspace(workspace, UPLOAD_DIR)).abs;
  await mkdir(dir, { recursive: true });
  const saved: SavedUpload[] = [];
  for (const part of parts) {
    const stored = `${randomUUID().slice(0, 8)}_${sanitizeFilename(part.filename)}`;
    const rel = `${UPLOAD_DIR}/${stored}`;
    if (isSecretPath(rel))
      throw new UploadError(
        403,
        `nama file ditolak (jalur rahasia): ${sanitizeFilename(part.filename)}`,
      );
    const { abs } = await resolveInWorkspace(workspace, rel);
    await writeFile(abs, part.data);
    saved.push({ path: rel, name: part.filename, bytes: part.data.length });
  }
  return saved;
}
