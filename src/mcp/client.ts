// Minimal MCP client: JSON-RPC 2.0 over stdio, no new dependencies.
// The server process is spawned directly (never through a shell) and is
// killed when the client closes. Only stdio transport is supported.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export const MCP_DEFAULT_TIMEOUT_MS = 15_000;
export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_CLIENT_NAME = "bikinin-ai";
export const MCP_CLIENT_VERSION = "0.0.1";

const MAX_STDERR_CHARS = 4_000;

export interface McpServerConfig {
  /** Display name (used in error messages; required by mcp_call config). */
  name?: string;
  command: string;
  args?: string[];
  /** Extra env vars for the server process (on top of the parent env). */
  env?: Record<string, string>;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpToolResult {
  content: McpToolContentPart[];
  isError?: boolean;
}

export interface McpClientOptions {
  /** Per-request timeout in ms (default 15 detik). */
  timeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: string | number;
  result?: unknown;
  error?: { code?: number; message?: string };
  method?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isJsonSafe(value: unknown, seen = new Set<object>()): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return true;
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      return false;
    case "object": {
      if (seen.has(value)) return false;
      seen.add(value);
      if (Array.isArray(value)) return value.every((v) => isJsonSafe(v, seen));
      return Object.values(value).every((v) => isJsonSafe(v, seen));
    }
    default:
      return false;
  }
}

/** Opaque handle for one connected MCP server. */
export class McpClient {
  readonly config: McpServerConfig;
  readonly timeoutMs: number;
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private stdoutBuf = "";
  private stderrBuf = "";
  private closed = false;
  private exitInfo: { code: number | null; signal: string | null } | null =
    null;

  constructor(
    config: McpServerConfig,
    proc: ChildProcessWithoutNullStreams,
    timeoutMs: number,
  ) {
    this.config = config;
    this.proc = proc;
    this.timeoutMs = timeoutMs;
    proc.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    proc.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuf = (this.stderrBuf + chunk.toString("utf8")).slice(
        -MAX_STDERR_CHARS,
      );
    });
    proc.on("error", (err) => {
      this.failAllPending(
        new Error(`server MCP tidak bisa dijalankan: ${err.message}`),
      );
    });
    proc.on("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      this.failAllPending(this.exitError());
    });
  }

  private exitError(): Error {
    const tail = this.stderrBuf.trim();
    const detail =
      this.exitInfo?.code !== null && this.exitInfo?.code !== undefined
        ? `exit code ${this.exitInfo.code}`
        : `signal ${this.exitInfo?.signal ?? "?"}`;
    return new Error(`server MCP mati (${detail})${tail ? `: ${tail}` : ""}`);
  }

  private failAllPending(error: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuf += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (line === "") continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        // Bukan JSON-RPC: abaikan (mis. log server yang nyasar ke stdout).
        continue;
      }
      this.onMessage(msg);
    }
  }

  private onMessage(msg: unknown): void {
    if (!isRecord(msg) || msg.jsonrpc !== "2.0") return;
    // Server mengirim request (mis. roots/list): client minimal ini tidak
    // melayani apa pun, jadi jawab "method tidak dikenal".
    if (typeof msg.method === "string") {
      if (msg.id !== undefined) {
        try {
          this.send({
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: -32601,
              message: `method tidak dikenal: ${msg.method}`,
            },
          });
        } catch {
          // Server sudah mati; tidak ada yang bisa menerima balasan.
        }
      }
      return; // notifikasi dari server: abaikan
    }
    if (typeof msg.id !== "number") return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (isRecord(msg.error)) {
      pending.reject(rpcError(pending.method, msg.error));
      return;
    }
    pending.resolve(msg.result);
  }

  private send(payload: Record<string, unknown>): void {
    if (this.closed || this.proc.exitCode !== null) {
      throw this.exitInfo
        ? this.exitError()
        : new Error("server MCP sudah mati");
    }
    this.proc.stdin.write(JSON.stringify(payload) + "\n");
  }

  /** One JSON-RPC request with its own timeout. Rejects on timeout, server death, or RPC error. */
  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("server MCP sudah ditutup"));
    }
    if (this.proc.exitCode !== null) {
      return Promise.reject(this.exitError());
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `timeout ${this.timeoutMs} ms menunggu jawaban server MCP untuk '${method}'`,
          ),
        );
      }, this.timeoutMs);
      // Unref agar timer tidak menahan proses saat server sudah mati.
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.send({
          jsonrpc: "2.0",
          id,
          method,
          params: params ?? {},
        });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Kills the server process and rejects any pending request. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAllPending(new Error("koneksi MCP ditutup"));
    const proc = this.proc;
    if (proc.exitCode === null) {
      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        proc.once("exit", done);
        const force = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // Sudah mati di antara cek dan kill.
          }
          resolve();
        }, 2_000);
        force.unref?.();
      });
    }
  }
}

function rpcError(
  method: string,
  error: { code?: number; message?: string },
): Error {
  const code = error.code;
  const message = error.message ?? "(tanpa pesan)";
  if (code === -32601)
    return new Error(
      `method tidak dikenal oleh server MCP ('${method}'): ${message}`,
    );
  if (code === -32602)
    return new Error(`argumen tidak valid untuk '${method}': ${message}`);
  return new Error(`server MCP mengembalikan error ${code ?? "?"}: ${message}`);
}

/**
 * Spawn an MCP server over stdio and run the initialize handshake.
 * Throws a clear error when the server cannot start, dies, or times out.
 */
export async function connectMcpServer(
  cfg: McpServerConfig,
  opts: McpClientOptions = {},
): Promise<McpClient> {
  if (!cfg.command || cfg.command.trim() === "") {
    throw new Error("config MCP tidak valid: command kosong");
  }
  const timeoutMs = opts.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;
  let proc: ChildProcessWithoutNullStreams;
  try {
    proc = spawn(cfg.command, cfg.args ?? [], {
      shell: false,
      env: { ...process.env, ...(cfg.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(
      `server MCP tidak bisa dijalankan ('${cfg.command}'): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const client = new McpClient(cfg, proc, timeoutMs);
  try {
    await client.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
    });
    // Notification: no response expected.
    proc.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }) + "\n",
    );
  } catch (err) {
    await client.close();
    throw err instanceof Error ? err : new Error(String(err));
  }
  return client;
}

/** Lists the tools a connected MCP server offers. */
export async function listMcpTools(client: McpClient): Promise<McpToolDef[]> {
  const result = await client.request("tools/list");
  if (!isRecord(result) || !Array.isArray(result.tools)) {
    throw new Error("server MCP mengembalikan tools/list yang tidak valid");
  }
  const tools: McpToolDef[] = [];
  for (const t of result.tools) {
    if (!isRecord(t) || typeof t.name !== "string" || t.name === "") {
      throw new Error("server MCP mengembalikan tool tanpa nama yang valid");
    }
    tools.push({
      name: t.name,
      description:
        typeof t.description === "string" ? t.description : undefined,
      inputSchema: isRecord(t.inputSchema) ? t.inputSchema : undefined,
    });
  }
  return tools;
}

const TOOL_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/**
 * Calls one tool on a connected MCP server.
 * Validates the tool name and that arguments are plain JSON before sending.
 */
export async function callMcpTool(
  client: McpClient,
  name: string,
  args: Record<string, unknown> = {},
): Promise<McpToolResult> {
  if (!TOOL_NAME_RE.test(name)) {
    throw new Error(
      `nama tool MCP tidak valid: '${name}' (hanya huruf, angka, _, -, .)`,
    );
  }
  if (!isJsonSafe(args)) {
    throw new Error(
      "argumen tool MCP harus berupa JSON biasa (tanpa undefined, fungsi, atau referensi melingkar)",
    );
  }
  const result = await client.request("tools/call", {
    name,
    arguments: args,
  });
  if (!isRecord(result) || !Array.isArray(result.content)) {
    throw new Error(
      `server MCP mengembalikan hasil tools/call yang tidak valid untuk '${name}'`,
    );
  }
  const content: McpToolContentPart[] = [];
  for (const part of result.content) {
    if (!isRecord(part) || typeof part.type !== "string") {
      throw new Error(
        `server MCP mengembalikan content yang tidak valid untuk '${name}'`,
      );
    }
    content.push(part as McpToolContentPart);
  }
  return {
    content,
    isError: typeof result.isError === "boolean" ? result.isError : undefined,
  };
}

/** Shuts a client down (kills the server process). */
export async function closeMcp(client: McpClient): Promise<void> {
  await client.close();
}
