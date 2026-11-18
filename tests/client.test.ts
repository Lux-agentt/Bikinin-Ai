// Tests for the OpenAI-compatible client: provider error bodies are
// preserved (a bare status makes 400s undiagnosable — live eval Gemini
// 2026-11-18: first request OK, a later one 400'd, body discarded).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  createOpenAiLlm,
  echoAssistantMessage,
  type ChatMessage,
} from "../src/llm/client.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

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

const readFileTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "read_file",
    description: "baca file",
    parameters: { type: "object", properties: {} },
  },
};

const toolCallChunk = (sig: string, msgSig = "sig-msg") =>
  JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"a.txt"}' },
              extra_content: { google: { thought_signature: sig } },
            },
          ],
          extra_content: { google: { thought_signature: msgSig } },
        },
        finish_reason: null,
      },
    ],
  });

const finishChunk = (reason: string) =>
  JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });

const textChunk = (text: string) =>
  JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: text },
        finish_reason: null,
      },
    ],
  });

/** Serves one scripted SSE stream per request, capturing request bodies. */
async function withSseServer(
  scripts: string[][],
  basePath: string,
  run: (bodies: unknown[], baseURL: string) => Promise<void>,
): Promise<void> {
  const bodies: unknown[] = [];
  let n = 0;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      bodies.push(raw ? JSON.parse(raw) : null);
      const chunks = scripts[Math.min(n++, scripts.length - 1)];
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const c of chunks) res.write(`data: ${c}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(bodies, `http://127.0.0.1:${port}${basePath}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

type CapturedBody = {
  messages: Array<{
    role?: string;
    extra_content?: { google?: { thought_signature?: string } };
    tool_calls?: Array<{
      extra_content?: { google?: { thought_signature?: string } };
    }>;
  }>;
};

describe("Gemini thought signature round-trip", () => {
  it("captures the signature from a streamed tool call", async () => {
    await withSseServer(
      [[toolCallChunk("sig-abc"), finishChunk("tool_calls")]],
      "/v1",
      async (bodies, baseURL) => {
        const llm = createOpenAiLlm({
          baseURL,
          apiKey: "test-key",
          quota: { enabled: false },
        });
        const r = await llm.chat({
          model: "test-model",
          messages: [{ role: "user", content: "baca a.txt" }],
          tools: [readFileTool],
        });
        expect(r.toolCalls[0]?.thoughtSignature).toBe("sig-abc");
        expect(bodies).toHaveLength(1);
      },
    );
  });

  it("captures the turn-level signature from a message delta", async () => {
    await withSseServer(
      [[toolCallChunk("sig-abc", "sig-msg"), finishChunk("tool_calls")]],
      "/v1",
      async (bodies, baseURL) => {
        const llm = createOpenAiLlm({
          baseURL,
          apiKey: "test-key",
          quota: { enabled: false },
        });
        const r = await llm.chat({
          model: "test-model",
          messages: [{ role: "user", content: "baca a.txt" }],
          tools: [readFileTool],
        });
        expect(r.toolCalls[0]?.thoughtSignature).toBe("sig-abc");
        expect(r.messageThoughtSignature).toBe("sig-msg");
        expect(bodies).toHaveLength(1);
      },
    );
  });

  it("strips extra_content when echoing to a non-Gemini provider", async () => {
    await withSseServer(
      [
        [toolCallChunk("sig-abc"), finishChunk("tool_calls")],
        [textChunk("Selesai."), finishChunk("stop")],
      ],
      "/v1",
      async (bodies, baseURL) => {
        const llm = createOpenAiLlm({
          baseURL,
          apiKey: "test-key",
          quota: { enabled: false },
        });
        const first = await llm.chat({
          model: "test-model",
          messages: [{ role: "user", content: "baca a.txt" }],
          tools: [readFileTool],
        });
        expect(first.toolCalls[0]?.thoughtSignature).toBe("sig-abc");
        expect(first.messageThoughtSignature).toBe("sig-msg");
        const messages: ChatMessage[] = [
          { role: "user", content: "baca a.txt" },
          echoAssistantMessage(first),
          { role: "tool", tool_call_id: "call_1", content: "hello\n" },
        ];
        await llm.chat({ model: "test-model", messages, tools: [] });
        expect(bodies).toHaveLength(2);
        const second = bodies[1] as CapturedBody;
        const asst = second.messages[1] ?? {};
        expect(asst).not.toHaveProperty("extra_content");
        const tc = asst.tool_calls?.[0] ?? {};
        expect(tc).not.toHaveProperty("extra_content");
      },
    );
  });

  it("keeps extra_content when echoing to Gemini", async () => {
    await withSseServer(
      [
        [toolCallChunk("sig-abc"), finishChunk("tool_calls")],
        [textChunk("Selesai."), finishChunk("stop")],
      ],
      "/generativelanguage.googleapis.com/v1",
      async (bodies, baseURL) => {
        const llm = createOpenAiLlm({
          baseURL,
          apiKey: "test-key",
          quota: { enabled: false },
        });
        const first = await llm.chat({
          model: "test-model",
          messages: [{ role: "user", content: "baca a.txt" }],
          tools: [readFileTool],
        });
        const messages: ChatMessage[] = [
          { role: "user", content: "baca a.txt" },
          echoAssistantMessage(first),
          { role: "tool", tool_call_id: "call_1", content: "hello\n" },
        ];
        await llm.chat({ model: "test-model", messages, tools: [] });
        expect(bodies).toHaveLength(2);
        const second = bodies[1] as CapturedBody;
        const asst = second.messages[1] ?? {};
        expect(asst.extra_content?.google?.thought_signature).toBe("sig-msg");
        const tc = asst.tool_calls?.[0] ?? {};
        expect(tc.extra_content?.google?.thought_signature).toBe("sig-abc");
      },
    );
  });
});
