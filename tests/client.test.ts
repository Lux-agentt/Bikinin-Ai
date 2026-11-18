// Tests for the OpenAI-compatible client: provider error bodies are
// preserved (a bare status makes 400s undiagnosable — live eval Gemini
// 2026-11-18: first request OK, a later one 400'd, body discarded).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createOpenAiLlm } from "../src/llm/client.js";

async function withErrorServer(
  status: number,
  body: unknown,
  run: (baseURL: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("provider error detail", () => {
  it("400 keeps the provider's own message instead of only the status", async () => {
    await withErrorServer(
      400,
      {
        error: {
          message:
            "Invalid function call format: tool role message must follow an assistant message with tool_calls",
          type: "invalid_request_error",
        },
      },
      async (baseURL) => {
        const llm = createOpenAiLlm({
          baseURL,
          apiKey: "test-key",
          quota: { enabled: false },
        });
        await expect(
          llm.chat({
            model: "test-model",
            messages: [{ role: "user", content: "hi" }],
            tools: [],
          }),
        ).rejects.toThrow(/Invalid function call format/);
      },
    );
  });

  it("5xx keeps the provider's own message too", async () => {
    await withErrorServer(
      502,
      { error: { message: "Bad gateway from upstream model", type: "server_error" } },
      async (baseURL) => {
        const llm = createOpenAiLlm({
          baseURL,
          apiKey: "test-key",
          quota: { enabled: false },
          maxRetries: 0,
          sleep: async () => {},
        });
        await expect(
          llm.chat({
            model: "test-model",
            messages: [{ role: "user", content: "hi" }],
            tools: [],
          }),
        ).rejects.toThrow(/Bad gateway from upstream model/);
      },
    );
  });
});
