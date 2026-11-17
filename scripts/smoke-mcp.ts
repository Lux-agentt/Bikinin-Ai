// Smoke test Track D (Fase 6): client MCP -> echo server -> hasil kembali.
// Jalan offline, tanpa network/npx: echo server dijalankan lewat tsx lokal.
//   npx tsx scripts/smoke-mcp.ts
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  callMcpTool,
  closeMcp,
  connectMcpServer,
  listMcpTools,
} from "../src/mcp/client.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const echoServer = join(root, "scripts", "mcp-echo-server.ts");
const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");

async function main(): Promise<void> {
  const client = await connectMcpServer({
    command: process.execPath,
    args: [tsxCli, echoServer],
  });
  try {
    const tools = await listMcpTools(client);
    console.log("tools:", tools.map((t) => t.name).join(", "));
    if (!tools.some((t) => t.name === "echo")) {
      throw new Error("tool 'echo' tidak ada di server");
    }
    const result = await callMcpTool(client, "echo", {
      text: "halo dari smoke test",
    });
    const text = result.content
      .map((c) => (c.type === "text" ? (c.text ?? "") : JSON.stringify(c)))
      .join("");
    console.log("echo:", text);
    if (text !== "halo dari smoke test") {
      throw new Error(`echo tidak sama: '${text}'`);
    }
    console.log("SMOKE MCP OK");
  } finally {
    await closeMcp(client);
  }
}

try {
  await main();
} catch (err) {
  console.error(
    "SMOKE MCP GAGAL:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
}
