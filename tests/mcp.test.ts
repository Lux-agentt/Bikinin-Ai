import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  callMcpTool,
  closeMcp,
  connectMcpServer,
  listMcpTools,
} from "../src/mcp/client.js";
import {
  MCP_SERVERS_ENV,
  mcpCallTool,
  parseMcpServersEnv,
} from "../src/tools/mcp-call.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const echoServer = join(root, "scripts", "mcp-echo-server.ts");
const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");

function echoConfig() {
  return {
    name: "echo",
    command: process.execPath,
    args: [tsxCli, echoServer],
  };
}

afterEach(() => {
  delete process.env[MCP_SERVERS_ENV];
});

describe("MCP client <-> echo server", () => {
  it("connect + list menemukan tool echo", async () => {
    const client = await connectMcpServer(echoConfig());
    try {
      const tools = await listMcpTools(client);
      expect(tools.map((t) => t.name)).toContain("echo");
      expect(tools[0].description).toMatch(/teks yang sama/);
    } finally {
      await closeMcp(client);
    }
  });

  it("call echo mengembalikan teks yang sama", async () => {
    const client = await connectMcpServer(echoConfig());
    try {
      const r = await callMcpTool(client, "echo", { text: "halo mcp" });
      expect(r.isError).not.toBe(true);
      expect(r.content).toEqual([{ type: "text", text: "halo mcp" }]);
    } finally {
      await closeMcp(client);
    }
  });

  it("call tool yang tidak ada memberi error jelas", async () => {
    const client = await connectMcpServer(echoConfig());
    try {
      await expect(callMcpTool(client, "tidak-ada", {})).rejects.toThrow(
        /tidak dikenal/,
      );
    } finally {
      await closeMcp(client);
    }
  });

  it("timeout saat server tidak menjawab", async () => {
    const client = await connectMcpServer(
      {
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
      },
      { timeoutMs: 300 },
    ).catch((err: unknown) => err);
    expect(client).toBeInstanceOf(Error);
    expect((client as Error).message).toMatch(/timeout/);
  });

  it("server yang langsung mati memberi error jelas", async () => {
    await expect(
      connectMcpServer({ command: process.execPath, args: ["-e", ""] }),
    ).rejects.toThrow(/mati/);
  });

  it("command yang tidak ada memberi error jelas", async () => {
    await expect(
      connectMcpServer({ command: "/tidak/ada/perintah-xyz" }),
    ).rejects.toThrow(/tidak bisa dijalankan/);
  });
});

describe("parseMcpServersEnv", () => {
  it("env kosong -> error jelas", () => {
    expect(() => parseMcpServersEnv(undefined)).toThrow(
      /tidak ada MCP server yang dikonfigurasi/,
    );
    expect(() => parseMcpServersEnv("  ")).toThrow(
      /tidak ada MCP server yang dikonfigurasi/,
    );
  });

  it("JSON tidak valid -> error jelas", () => {
    expect(() => parseMcpServersEnv("{bukan json")).toThrow(/bukan JSON/);
  });

  it("config valid lolos, nama duplikat ditolak", () => {
    const ok = parseMcpServersEnv(
      JSON.stringify([{ name: "echo", command: "npx", args: ["tsx", "x"] }]),
    );
    expect(ok).toEqual([
      { name: "echo", command: "npx", args: ["tsx", "x"], env: {} },
    ]);
    expect(() =>
      parseMcpServersEnv(
        JSON.stringify([
          { name: "a", command: "x" },
          { name: "a", command: "y" },
        ]),
      ),
    ).toThrow(/dua kali/);
  });
});

describe("tool mcp_call", () => {
  it("end-to-end: echo lewat env config", async () => {
    process.env[MCP_SERVERS_ENV] = JSON.stringify([echoConfig()]);
    const parsed = mcpCallTool.parse({
      server: "echo",
      tool: "echo",
      arguments: { text: "halo tool" },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("parse gagal");
    const r = await parsed.execute({ workspace: "/tmp" });
    expect(r.ok).toBe(true);
    expect(r.output).toBe("halo tool");
  });

  it("env kosong -> error jelas", async () => {
    const parsed = mcpCallTool.parse({
      server: "echo",
      tool: "echo",
      arguments: { text: "x" },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("parse gagal");
    await expect(parsed.execute({ workspace: "/tmp" })).rejects.toThrow(
      /tidak ada MCP server yang dikonfigurasi/,
    );
  });

  it("server tidak ada di config -> error jelas", async () => {
    process.env[MCP_SERVERS_ENV] = JSON.stringify([echoConfig()]);
    const parsed = mcpCallTool.parse({
      server: "lain",
      tool: "echo",
      arguments: {},
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("parse gagal");
    await expect(parsed.execute({ workspace: "/tmp" })).rejects.toThrow(
      /tidak ada di BIKININ_MCP_SERVERS/,
    );
  });

  it("tool tidak ada di server -> error jelas", async () => {
    process.env[MCP_SERVERS_ENV] = JSON.stringify([echoConfig()]);
    const parsed = mcpCallTool.parse({
      server: "echo",
      tool: "tidak-ada",
      arguments: {},
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("parse gagal");
    await expect(parsed.execute({ workspace: "/tmp" })).rejects.toThrow(
      /tidak ada di server MCP/,
    );
  });

  it("nama tool tidak valid ditolak di validasi argumen", () => {
    expect(
      mcpCallTool.parse({ server: "echo", tool: "a b", arguments: {} }).ok,
    ).toBe(false);
  });
});
