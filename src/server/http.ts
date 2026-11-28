// HTTP server for the web UI. Node's http module only, no framework.
// Serves the UI, the JSON API from AGENTS.md 8.4, SSE events, and file previews from the workspace.
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentError } from "../errors.js";
import { ApprovalBody, StartRunBody, toSSE } from "../events.js";
import { resolveInWorkspace } from "../safety/paths.js";
import { installSkill, InstallError } from "../skills/install.js";
import { listSkills, skillsDir } from "../skills/loader.js";
import { BusyError, NotConfiguredError, BadAttachmentError, type RunManager } from "./runs.js";
import { EvalManager } from "./evals.js";
import { buildTranscript, transcriptFilename } from "./transcript.js";
import { buildZip } from "./zip.js";
import { listCheckpoints } from "./checkpoints.js";
import { saveUploads, UploadError } from "./uploads.js";

const PUBLIC_DIR = fileURLToPath(new URL("../../public/", import.meta.url));
const MAX_BODY = 64 * 1024;
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
const MAX_ZIP_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 20 * 1024 * 1024;

const ASSETS: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/md.js": { file: "md.js", type: "text/javascript; charset=utf-8" },
  "/logo.png": { file: "logo.png", type: "image/png" },
  "/fonts/inter-latin-wght-normal.woff2": { file: "fonts/inter-latin-wght-normal.woff2", type: "font/woff2" },
  "/fonts/source-serif-4-latin-wght-normal.woff2": { file: "fonts/source-serif-4-latin-wght-normal.woff2", type: "font/woff2" },
  "/fonts/source-serif-4-latin-wght-italic.woff2": { file: "fonts/source-serif-4-latin-wght-italic.woff2", type: "font/woff2" },
  "/fonts/fonts.css": { file: "fonts/fonts.css", type: "text/css; charset=utf-8" },
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

// Previews run in an opaque origin: no cookies, no access to the UI's storage or API.
const PREVIEW_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline' https:",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob: https:",
  "font-src data: https:",
  "media-src data: blob: https:",
  "connect-src 'none'",
].join("; ");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "body terlalu besar");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "JSON tidak valid");
  }
}

async function sendAsset(res: ServerResponse, key: string): Promise<void> {
  const asset = ASSETS[key];
  const body = await readFile(new URL(asset.file, `file://${PUBLIC_DIR}`));
  res.writeHead(200, {
    "Content-Type": asset.type,
    "Content-Security-Policy": UI_CSP,
    "Cache-Control": "no-cache",
    ...SECURITY_HEADERS,
    "X-Frame-Options": "DENY",
  });
  res.end(body);
}

async function servePreview(
  res: ServerResponse,
  workspace: string,
  rawPath: string,
): Promise<void> {
  let rel: string;
  try {
    rel = decodeURIComponent(rawPath);
  } catch {
    throw new HttpError(400, "path tidak valid");
  }
  let abs: string;
  try {
    ({ abs } = await resolveInWorkspace(workspace, rel));
  } catch (err) {
    if (err instanceof AgentError && err.code === "path_blocked")
      throw new HttpError(403, "path ditolak");
    throw err;
  }
  let st;
  try {
    st = await stat(abs);
  } catch {
    throw new HttpError(404, "file tidak ditemukan");
  }
  if (!st.isFile()) throw new HttpError(404, "file tidak ditemukan");
  if (st.size > MAX_PREVIEW_BYTES)
    throw new HttpError(413, "file terlalu besar");

  const body = await readFile(abs);
  res.writeHead(200, {
    "Content-Type":
      MIME[extname(abs).toLowerCase()] ?? "application/octet-stream",
    "Content-Security-Policy": PREVIEW_CSP,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

async function serveDownload(
  res: ServerResponse,
  workspace: string,
  rawPath: string,
  inline = false,
): Promise<void> {
  let rel: string;
  try {
    rel = decodeURIComponent(rawPath);
  } catch {
    throw new HttpError(400, "path tidak valid");
  }
  let abs: string;
  try {
    ({ abs } = await resolveInWorkspace(workspace, rel));
  } catch (err) {
    if (err instanceof AgentError && err.code === "path_blocked")
      throw new HttpError(403, "path ditolak");
    throw err;
  }
  let st;
  try {
    st = await stat(abs);
  } catch {
    throw new HttpError(404, "file tidak ditemukan");
  }
  if (!st.isFile()) throw new HttpError(404, "file tidak ditemukan");
  // No size cap (unlike preview/zip): a rendered video is routinely
  // larger than 5 MB. Stream it instead of buffering it in memory.
  const filename = basename(abs).replace(/["\r\n]/g, "");
  // ?inline=1: tampilkan di tempat (mis. <video> di dalam chat) — tanpa
  // ini browser mengunduh. Default tetap attachment supaya tombol Unduh
  // di tab Files tidak berubah perilakunya.
  const disposition = inline ? "inline" : "attachment";
  res.writeHead(200, {
    "Content-Type":
      MIME[extname(abs).toLowerCase()] ?? "application/octet-stream",
    "Content-Disposition": `${disposition}; filename="${filename}"`,
    "Content-Length": String(st.size),
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
  });
  await new Promise<void>((resolve) => {
    const stream = createReadStream(abs);
    stream.on("error", () => {
      if (!res.writableEnded) res.destroy();
      resolve();
    });
    stream.on("end", resolve);
    stream.pipe(res);
  });
}

function streamEvents(
  req: IncomingMessage,
  res: ServerResponse,
  manager: RunManager,
  runId: string,
): void {
  const rec = manager.get(runId);
  if (!rec) throw new HttpError(404, "run tidak ditemukan");

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...SECURITY_HEADERS,
  });

  const header = req.headers["last-event-id"];
  const lastSeen = Number(Array.isArray(header) ? header[0] : (header ?? -1));
  const after = Number.isFinite(lastSeen) ? lastSeen : -1;

  // Replay first, then subscribe. Both happen synchronously, so no event is missed in between.
  for (const e of rec.events) {
    if (e.seq > after) res.write(toSSE(e));
  }
  if (rec.finished) {
    res.end();
    return;
  }

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
  const listener = (e: (typeof rec.events)[number]) => {
    res.write(toSSE(e));
    if (e.type === "run_finished") {
      cleanup();
      res.end();
    }
  };
  const cleanup = () => {
    clearInterval(heartbeat);
    rec.listeners.delete(listener);
  };
  rec.listeners.add(listener);
  req.on("close", cleanup);
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  manager: RunManager,
  workspace: string,
  evals: EvalManager,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path in ASSETS) return sendAsset(res, path);

  if (method === "GET" && path.startsWith("/preview/")) {
    return servePreview(res, workspace, path.slice("/preview/".length));
  }

  if (method === "GET" && path === "/api/config") {
    return sendJson(res, 200, manager.info());
  }

  if (method === "GET" && path === "/api/sessions") {
    return sendJson(res, 200, manager.listSessions());
  }

  const del = path.match(/^\/api\/sessions\/(s_[a-f0-9]{8})$/);
  if (method === "DELETE" && del) {
    const r = await manager.deleteSession(del[1]);
    if (r === "not-found") throw new HttpError(404, "sesi tidak ditemukan");
    if (r === "busy")
      throw new HttpError(
        409,
        "masih ada run yang berjalan di sesi ini — hentikan dulu",
      );
    return sendJson(res, 200, { ok: true });
  }

  if (method === "GET" && path === "/api/skills") {
    return sendJson(res, 200, await listSkills(skillsDir()));
  }

  if (method === "POST" && path === "/api/skills") {
    const body = (await readJson(req)) as {
      url?: unknown;
      content?: unknown;
      name?: unknown;
    };
    const url = typeof body.url === "string" ? body.url : undefined;
    const content =
      typeof body.content === "string" ? body.content : undefined;
    const name = typeof body.name === "string" ? body.name : undefined;
    if ((url ? 1 : 0) + (content ? 1 : 0) !== 1) {
      throw new HttpError(
        400,
        "isi salah satu: url (link GitHub ke SKILL.md) atau content (isi SKILL.md)",
      );
    }
    try {
      const skill = await installSkill({ url, content, name });
      return sendJson(res, 201, { skill });
    } catch (err) {
      if (err instanceof InstallError) {
        throw new HttpError(err.status, err.message);
      }
      throw err;
    }
  }

  // Fitur 3: eval benchmark (Fase 7) dari UI. Satu eval dalam satu waktu;
  // proses anaknya jalan 10-25 menit untuk satu batch penuh.
  if (method === "POST" && path === "/api/evals") {
    const body = (await readJson(req)) as {
      model?: unknown;
      tasks?: unknown;
    };
    const r = evals.start(body.model, body.tasks);
    if ("error" in r) {
      if (r.error === "busy") throw new HttpError(409, r.message);
      throw new HttpError(400, r.message);
    }
    return sendJson(res, 201, { eval: r.record });
  }

  if (method === "GET" && path === "/api/evals") {
    return sendJson(res, 200, {
      tasks: evals.taskCatalog(),
      evals: evals.list(),
    });
  }

  const em = path.match(/^\/api\/evals\/(eval_[a-f0-9]{8})$/);
  if (method === "GET" && em) {
    const rec = evals.get(em[1]);
    if (!rec) throw new HttpError(404, "eval tidak ditemukan");
    return sendJson(res, 200, { ...rec, log: await evals.logTail(em[1]) });
  }

  // Fase 5: checkpoints. Restore is an explicit user action (POST only)
  // and is recorded as a `checkpoint_restored` event in the session log.
  if (method === "GET" && path === "/api/checkpoints") {
    return sendJson(res, 200, await listCheckpoints(workspace));
  }

  const cp = path.match(/^\/api\/checkpoints\/(cp_[a-f0-9]{8})\/restore$/);
  if (method === "POST" && cp) {
    try {
      return sendJson(res, 200, await manager.restoreCheckpoint(cp[1]));
    } catch (err) {
      throw new HttpError(
        404,
        err instanceof Error ? err.message : "checkpoint tidak ditemukan",
      );
    }
  }

  const sm = path.match(
    /^\/api\/sessions\/(s_[a-f0-9]{8})(\/files|\/download\.zip|\/download|\/ledger|\/transcript)?$/,
  );
  if (method === "GET" && sm) {
    const [, sessionId, action] = sm;
    const sess = await manager.getSession(sessionId);
    if (!sess) throw new HttpError(404, "sesi tidak ditemukan");
    if (!action) return sendJson(res, 200, sess);
    if (action === "/transcript") {
      const body = Buffer.from(buildTranscript(sess), "utf8");
      const filename = transcriptFilename(sess).replace(/["\r\n]/g, "");
      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(body.length),
        "Cache-Control": "no-store",
        ...SECURITY_HEADERS,
      });
      res.end(body);
      return;
    }
    if (action === "/ledger") {
      return sendJson(res, 200, await manager.getLedger(sessionId));
    }
    if (action === "/files") {
      return sendJson(res, 200, await manager.listFiles());
    }
    if (action === "/download") {
      // Single-file download (e.g. a rendered video): unlike the zip,
      // there is no 5 MB per-file cap — the file streams straight out.
      // ?inline=1 serves it for in-page playback instead of downloading.
      const rawPath = url.searchParams.get("path");
      if (!rawPath) throw new HttpError(400, "path tidak diberikan");
      return serveDownload(
        res,
        workspace,
        rawPath,
        url.searchParams.get("inline") === "1",
      );
    }
    // download.zip: the whole current workspace (shared by all sessions).
    const entries: Array<{ path: string; data: Buffer }> = [];
    let total = 0;
    for (const f of await manager.listFiles()) {
      if (f.bytes > MAX_ZIP_FILE_BYTES) continue;
      if (total + f.bytes > MAX_ZIP_TOTAL_BYTES) break;
      const { abs } = await resolveInWorkspace(workspace, f.path);
      entries.push({ path: f.path, data: await readFile(abs) });
      total += f.bytes;
    }
    if (entries.length === 0)
      throw new HttpError(404, "tidak ada file untuk diunduh");
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="bikinin-${sessionId}.zip"`,
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS,
    });
    res.end(buildZip(entries));
    return;
  }

  if (method === "POST" && path === "/api/uploads") {
    try {
      return sendJson(res, 201, {
        uploads: await saveUploads(req, workspace),
      });
    } catch (err) {
      if (err instanceof UploadError)
        throw new HttpError(err.status, err.message);
      throw err;
    }
  }

  if (method === "POST" && path === "/api/runs") {
    const parsed = StartRunBody.safeParse(await readJson(req));
    if (!parsed.success) throw new HttpError(400, "isi permintaan tidak valid");
    try {
      return sendJson(res, 201, manager.start(parsed.data));
    } catch (err) {
      if (err instanceof BusyError) throw new HttpError(409, err.message);
      if (err instanceof NotConfiguredError)
        throw new HttpError(503, err.message);
      if (err instanceof BadAttachmentError)
        throw new HttpError(400, err.message);
      throw err;
    }
  }

  const m = path.match(
    /^\/api\/runs\/(run_[a-f0-9]{8})\/(events|stop|approval|resume)$/,
  );
  if (m) {
    const [, runId, action] = m;
    if (method === "GET" && action === "events")
      return streamEvents(req, res, manager, runId);
    if (method === "POST" && action === "stop") {
      if (!manager.stop(runId)) throw new HttpError(404, "run tidak ditemukan");
      return sendJson(res, 202, { ok: true });
    }
    if (method === "POST" && action === "resume") {
      const r = manager.resume(runId);
      if ("error" in r) {
        if (r.error === "not-found")
          throw new HttpError(404, "run tidak ditemukan");
        if (r.error === "busy")
          throw new HttpError(409, "masih ada run yang berjalan");
        throw new HttpError(409, "run ini tidak bisa dilanjutkan");
      }
      return sendJson(res, 201, r);
    }
    if (method === "POST" && action === "approval") {
      const parsed = ApprovalBody.safeParse(await readJson(req));
      if (!parsed.success)
        throw new HttpError(400, "isi persetujuan tidak valid");
      if (
        !manager.approve(runId, parsed.data.approval_id, parsed.data.decision)
      ) {
        throw new HttpError(
          404,
          "persetujuan tidak ditemukan atau sudah dijawab",
        );
      }
      return sendJson(res, 200, { ok: true });
    }
  }

  throw new HttpError(404, "tidak ditemukan");
}

export function createAppServer(
  manager: RunManager,
  workspace: string,
  evals: EvalManager = new EvalManager(workspace, manager.listProviders()),
): Server {
  return createServer(async (req, res) => {
    try {
      await route(req, res, manager, workspace, evals);
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
      } else {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });
}
