// Tool mcp_call (Fase 6, Track D): panggil satu tool dari satu MCP server
// eksternal yang dikonfigurasi pemilik lewat env BIKININ_MCP_SERVERS.
// readOnly: false — tool MCP bisa apa saja (baca, tulis, jaringan), jadi
// keamanan datang dari server yang dipilih pemilik, bukan dari tool ini.
// Jangan pernah menaruh secret di BIKININ_MCP_SERVERS: server mewarisi env
// proses induk, jadi token sebaiknya lewat Codespaces secrets / env shell.
import { z } from "zod";
import { AgentError } from "../errors.js";
import {
  callMcpTool,
  closeMcp,
  connectMcpServer,
  listMcpTools,
  MCP_DEFAULT_TIMEOUT_MS,
  type McpServerConfig,
} from "../mcp/client.js";
import { defineTool, truncate } from "./types.js";

export const MCP_SERVERS_ENV = "BIKININ_MCP_SERVERS";

const McpServerConfigSchema = z.object({
  name: z.string().min(1).max(100),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
});

const McpServersSchema = z.array(McpServerConfigSchema).min(1);

/** One configured server from BIKININ_MCP_SERVERS (name is required there). */
export type ConfiguredMcpServer = McpServerConfig & { name: string };

const NO_SERVERS_MESSAGE =
  `tidak ada MCP server yang dikonfigurasi. Atur env ${MCP_SERVERS_ENV} ` +
  `sebagai JSON, contoh: [{"name":"echo","command":"npx","args":["tsx","scripts/mcp-echo-server.ts"]}] ` +
  `(tanpa secret di dalam JSON — token lewat env proses).`;

/** Parses BIKININ_MCP_SERVERS. Throws a clear AgentError when unset/invalid. */
export function parseMcpServersEnv(
  raw: string | undefined,
): ConfiguredMcpServer[] {
  if (!raw || raw.trim() === "") {
    throw new AgentError("tool_failed", NO_SERVERS_MESSAGE);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AgentError(
      "tool_failed",
      `${MCP_SERVERS_ENV} bukan JSON yang valid. ${NO_SERVERS_MESSAGE}`,
    );
  }
  const result = McpServersSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "config"}: ${i.message}`)
      .join("; ");
    throw new AgentError(
      "tool_failed",
      `${MCP_SERVERS_ENV} tidak valid: ${detail}`,
    );
  }
  const names = new Set<string>();
  for (const s of result.data) {
    if (names.has(s.name)) {
      throw new AgentError(
        "tool_failed",
        `${MCP_SERVERS_ENV} tidak valid: nama server '${s.name}' muncul dua kali`,
      );
    }
    names.add(s.name);
  }
  return result.data;
}

/** MCP tool results are { content: [{type, text?}], isError? }. */
export function mcpResultToText(result: {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
}): string {
  const parts = result.content.map((p) =>
    p.type === "text" && typeof p.text === "string"
      ? p.text
      : JSON.stringify(p),
  );
  return parts.join("\n") || "(tidak ada output)";
}

function toAgentError(err: unknown): AgentError {
  if (err instanceof AgentError) return err;
  return new AgentError(
    "tool_failed",
    err instanceof Error ? err.message : String(err),
  );
}

export const mcpCallTool = defineTool({
  name: "mcp_call",
  description:
    "Panggil satu tool dari MCP server eksternal yang dikonfigurasi pemilik (env BIKININ_MCP_SERVERS). readOnly: false — tool MCP bisa apa saja (baca/tulis/jaringan), jadi hanya pakai server yang dipercaya pemilik. Bila env kosong/tidak valid, tool mengembalikan error yang jelas.",
  parameters: {
    type: "object",
    properties: {
      server: {
        type: "string",
        description: "Nama server di BIKININ_MCP_SERVERS.",
      },
      tool: {
        type: "string",
        description: "Nama tool di server itu.",
      },
      arguments: {
        type: "object",
        description: "Argumen untuk tool (objek JSON).",
        additionalProperties: true,
      },
    },
    required: ["server", "tool"],
    additionalProperties: false,
  },
  readOnly: false,
  schema: z.object({
    server: z.string().trim().min(1).max(100),
    tool: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(
        /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/,
        "nama tool MCP hanya boleh huruf, angka, _, -, .",
      ),
    arguments: z.record(z.unknown()).default({}),
  }),
  label: (a) => `mcp_call ${a.server}/${a.tool}`,
  publicArgs: (a) => ({ server: a.server, tool: a.tool }),
  async run(a) {
    try {
      const servers = parseMcpServersEnv(process.env[MCP_SERVERS_ENV]);
      const cfg = servers.find((s) => s.name === a.server);
      if (!cfg) {
        throw new AgentError(
          "tool_failed",
          `server MCP '${a.server}' tidak ada di ${MCP_SERVERS_ENV}. Yang tersedia: ${servers.map((s) => s.name).join(", ")}`,
        );
      }
      const client = await connectMcpServer(cfg, {
        timeoutMs: MCP_DEFAULT_TIMEOUT_MS,
      });
      try {
        const tools = await listMcpTools(client);
        if (!tools.some((t) => t.name === a.tool)) {
          throw new AgentError(
            "tool_failed",
            `tool '${a.tool}' tidak ada di server MCP '${a.server}'. Yang tersedia: ${tools.map((t) => t.name).join(", ") || "(tidak ada)"}`,
          );
        }
        const result = await callMcpTool(client, a.tool, a.arguments);
        const { text } = truncate(mcpResultToText(result));
        if (result.isError) {
          return {
            ok: false,
            summary: `tool MCP ${a.server}/${a.tool} mengembalikan error`,
            output: text,
            changes: [],
          };
        }
        return {
          ok: true,
          summary: `mcp_call ${a.server}/${a.tool} selesai`,
          output: text,
          changes: [],
        };
      } finally {
        await closeMcp(client);
      }
    } catch (err) {
      throw toAgentError(err);
    }
  },
});
