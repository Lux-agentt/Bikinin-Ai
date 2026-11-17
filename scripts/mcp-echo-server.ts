// Contoh server MCP MINIMAL over stdio (Fase 6, Track D) — tanpa dependensi
// baru. Dipakai untuk smoke test offline: client bicara JSON-RPC 2.0, satu
// pesan JSON per baris, stdin/stdout. Log diagnostik hanya ke stderr —
// stdout harus bersih dari apa pun selain JSON-RPC.
//
// Jalankan manual:
//   npx tsx scripts/mcp-echo-server.ts
// Lalu kirim (satu baris JSON per pesan):
//   {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"x","version":"0.1.0"}}}
//   {"jsonrpc":"2.0","method":"notifications/initialized"}
//   {"jsonrpc":"2.0","id":2,"method":"tools/list"}
//   {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"text":"halo"}}}
import * as readline from "node:readline";

const SERVER_INFO = { name: "mcp-echo-server", version: "0.1.0" };
const PROTOCOL_VERSION = "2024-11-05";

type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function result(id: unknown, value: { [key: string]: JsonValue }): JsonValue {
  return { jsonrpc: "2.0", id: id as JsonValue, result: value };
}

function error(id: unknown, code: number, message: string): JsonValue {
  return {
    jsonrpc: "2.0",
    id: id as JsonValue,
    error: { code, message },
  };
}

function send(msg: JsonValue): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const ECHO_TOOL = {
  name: "echo",
  description:
    "Mengembalikan teks yang sama seperti yang dikirim (tool contoh untuk smoke test).",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Teks untuk dikembalikan" },
    },
    required: ["text"],
    additionalProperties: false,
  },
};

function handle(msg: JsonRpcMessage): JsonValue | null {
  const id = msg.id;
  const isNotification = id === undefined;

  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    if (isNotification) return null;
    return error(id ?? null, -32600, "request tidak valid");
  }

  switch (msg.method) {
    case "initialize":
      return result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "notifications/initialized":
      return null; // notifikasi: tanpa balasan
    case "tools/list":
      return result(id, { tools: [ECHO_TOOL] });
    case "tools/call": {
      const params = isRecord(msg.params) ? msg.params : {};
      const name = params.name;
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (name !== "echo") {
        return error(id, -32602, `tool tidak dikenal: ${String(name)}`);
      }
      if (typeof args.text !== "string") {
        return error(id, -32602, "tool echo butuh argumen 'text' (string)");
      }
      return result(id, {
        content: [{ type: "text", text: args.text }],
      });
    }
    default:
      if (isNotification) return null;
      return error(id, -32601, `method tidak dikenal: ${msg.method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  if (line.trim() === "") return;
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    send(error(null, -32700, "JSON tidak valid"));
    return;
  }
  if (!isRecord(msg)) {
    send(error(null, -32600, "request harus berupa objek JSON"));
    return;
  }
  const res = handle(msg as JsonRpcMessage);
  if (res !== null) send(res);
});

rl.on("close", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

console.error(`${SERVER_INFO.name} siap (stdio)`);
