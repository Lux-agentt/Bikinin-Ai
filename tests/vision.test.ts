// Vision capability map + fallback describeImage + the OpenAI client vision
// call (against a local fake OpenAI-compatible server, no real provider).
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { AgentError } from "../src/errors.js";
import { createOpenAiLlm, type LlmClient } from "../src/llm/client.js";
import { createFallbackLlm } from "../src/llm/fallback.js";
import type { ProviderConfig } from "../src/llm/providers.js";
import { supportsVision } from "../src/llm/vision-capability.js";

describe("supportsVision", () => {
  it.each([
    ["gemini-4-hydrogen", true],
    ["nvidia/nemotron-3.5-super-vl:free", true],
    ["NVIDIA/Nemotron-3.5-Super-VL:free", true],
  ])("%s -> true", (model, expected) => {
    expect(supportsVision(model)).toBe(expected);
  });

  it.each([
    ["cohere/north-mini-code:free", false],
    ["nvidia/nemotron-3.5-lightning:free", false],
    // Status unverified — fail-closed until the provider is checked.
    ["baidu/ernie-5.5-flash-preview:free", false],
    ["z-ai/glm-5.3-flash", false],
    ["model-tidak-dikenal", false],
    ["", false],
  ])("%s -> false", (model, expected) => {
    expect(supportsVision(model)).toBe(expected);
  });
});

const usage = { input_tokens: 100, output_tokens: 20, cached_tokens: 0 };

function provider(name: string, model: string): ProviderConfig {
  return {
    name,
    baseUrl: "https://x.test/v1",
    apiKey: "k",
    model,
    inPerM: 0,
    outPerM: 0,
  };
}

/** Fake client with a scripted describeImage; chat is unused here. */
function fakeVision(
  script: (model: string) => string | Promise<string>,
  calls: string[],
): (p: ProviderConfig) => LlmClient {
  return (p: ProviderConfig) => ({
    async chat() {
      throw new Error("chat tidak dipakai di tes ini");
    },
    async describeImage(req) {
      calls.push(p.name);
      const text = await script(req.model ?? p.model);
      return { text, model: req.model ?? p.model, usage };
    },
  });
}

const visionReq = {
  imageBase64: "iVBORw0KGgo=",
  mime: "image/png" as const,
  prompt: "Apa yang terlihat?",
};

describe("createFallbackLlm.describeImage", () => {
  it("skips non-vision models and returns the first vision answer", async () => {
    const calls: string[] = [];
    const llm = createFallbackLlm(
      [
        provider("or-north", "cohere/north-mini-code:free"),
        provider("or-supervl", "nvidia/nemotron-3.5-super-vl:free"),
        provider("gemini", "gemini-4-hydrogen"),
      ],
      { makeClient: fakeVision(() => "tombol merah di kanan atas", calls) },
    );
    const r = await llm.describeImage(visionReq);
    expect(r.text).toBe("tombol merah di kanan atas");
    expect(r.provider).toBe("or-supervl");
    expect(r.model).toBe("nvidia/nemotron-3.5-super-vl:free");
    expect(calls).toEqual(["or-supervl"]);
  });

  it("falls over when a vision model rejects the image (fallback-eligible)", async () => {
    const calls: string[] = [];
    const llm = createFallbackLlm(
      [
        provider("or-supervl", "nvidia/nemotron-3.5-super-vl:free"),
        provider("gemini", "gemini-4-hydrogen"),
      ],
      {
        makeClient: fakeVision((model) => {
          if (model === "nvidia/nemotron-3.5-super-vl:free")
            throw new AgentError(
              "provider_error",
              "tidak mendukung image input",
              false,
              true,
            );
          return "dari gemini";
        }, calls),
      },
    );
    const r = await llm.describeImage(visionReq);
    expect(r.text).toBe("dari gemini");
    expect(calls).toEqual(["or-supervl", "gemini"]);
  });

  it("does not fall over on a non-eligible error", async () => {
    const calls: string[] = [];
    const llm = createFallbackLlm(
      [
        provider("or-supervl", "nvidia/nemotron-3.5-super-vl:free"),
        provider("gemini", "gemini-4-hydrogen"),
      ],
      {
        makeClient: fakeVision(() => {
          throw new AgentError("provider_error", "saldo habis");
        }, calls),
      },
    );
    await expect(llm.describeImage(visionReq)).rejects.toThrow("saldo habis");
    expect(calls).toEqual(["or-supervl"]);
  });

  it("says so honestly when no configured model supports vision", async () => {
    const calls: string[] = [];
    const llm = createFallbackLlm(
      [
        provider("or-north", "cohere/north-mini-code:free"),
        provider("nano", "z-ai/glm-5.3-flash"),
      ],
      { makeClient: fakeVision(() => "tidak boleh terpanggil", calls) },
    );
    await expect(llm.describeImage(visionReq)).rejects.toThrow(
      "vision tidak tersedia di model yang dikonfigurasi",
    );
    expect(calls).toEqual([]);
  });
});

describe("createOpenAiLlm.describeImage (fake local server)", () => {
  interface Seen {
    model?: unknown;
    content?: unknown;
    maxTokens?: unknown;
  }

  /** describeImage is optional on LlmClient; the real client always has it. */
  function mustDescribe(llm: LlmClient) {
    if (!llm.describeImage) throw new Error("client tidak punya describeImage");
    return llm.describeImage.bind(llm);
  }

  /** Serves one canned /v1/chat/completions response; records the request. */
  async function withServer(
    status: number,
    body: unknown,
    run: (baseURL: string, seen: Seen) => Promise<void>,
  ): Promise<void> {
    const seen: Seen = {};
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString();
      });
      req.on("end", () => {
        const parsed = JSON.parse(raw) as {
          model?: unknown;
          messages?: Array<{ content?: unknown }>;
          max_tokens?: unknown;
        };
        seen.model = parsed.model;
        seen.content = parsed.messages?.[0]?.content;
        seen.maxTokens = parsed.max_tokens;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const { port } = server.address() as AddressInfo;
      await run(`http://127.0.0.1:${port}/v1`, seen);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  const okBody = {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: "gemini-4-hydrogen",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Form login, tombol biru." },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1200, completion_tokens: 50, total_tokens: 1250 },
  };

  it("sends the image as a data-URI part and returns text + usage", async () => {
    await withServer(200, okBody, async (baseURL, seen) => {
      const llm = createOpenAiLlm({ baseURL, apiKey: "test" });
      const r = await mustDescribe(llm)({
        ...visionReq,
        model: "gemini-4-hydrogen",
      });
      expect(r.text).toBe("Form login, tombol biru.");
      expect(r.model).toBe("gemini-4-hydrogen");
      expect(r.usage).toEqual({
        input_tokens: 1200,
        output_tokens: 50,
        cached_tokens: 0,
      });
      expect(seen.model).toBe("gemini-4-hydrogen");
      expect(seen.maxTokens).toBe(1024);
      const parts = seen.content as Array<Record<string, unknown>>;
      expect(parts[0]).toEqual({ type: "text", text: visionReq.prompt });
      expect(parts[1]).toEqual({
        type: "image_url",
        image_url: {
          url: `data:image/png;base64,${visionReq.imageBase64}`,
        },
      });
    });
  });

  it("marks a 400 image rejection as fallback-eligible", async () => {
    await withServer(
      400,
      {
        error: {
          message: "This model does not support image input",
          type: "invalid_request_error",
          code: "unsupported_value",
        },
      },
      async (baseURL) => {
        const llm = createOpenAiLlm({
          baseURL,
          apiKey: "test",
          maxRetries: 0,
        });
        let caught: unknown;
        try {
          await mustDescribe(llm)({ ...visionReq, model: "m" });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(AgentError);
        const e = caught as AgentError;
        expect(e.code).toBe("provider_error");
        expect(e.fallback).toBe(true);
        expect(e.retryable).toBe(false);
      },
    );
  });

  it("fails clearly when no model is given", async () => {
    const llm = createOpenAiLlm({
      baseURL: "http://127.0.0.1:1/v1",
      apiKey: "t",
    });
    await expect(mustDescribe(llm)(visionReq)).rejects.toThrow(
      "describeImage butuh model",
    );
  });
});
