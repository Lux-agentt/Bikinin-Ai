// OpenAI-compatible chat client: streaming, tool calls, bounded retry (429/5xx/network), timeout.
// Base URL, key and model always come from config. Nothing is hardcoded here.
import OpenAI, {
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { AgentError } from "../errors.js";
import {
  checkAndRecordFreeRequest,
  isFreeModel,
  resolveQuotaClient,
  type QuotaClientOptions,
} from "./quota.js";

export type ChatMessage = ChatCompletionMessageParam;

export interface ToolCallReq {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
}

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  tools: ChatCompletionTool[];
  signal?: AbortSignal;
  onText?: (text: string) => void;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCallReq[];
  usage: Usage;
  /** Set by the fallback client; the loop falls back to env prices when absent. */
  costUsd?: number;
  provider?: string;
  model?: string;
}

export interface VisionRequest {
  /** Raw base64 image data (no `data:` prefix). */
  imageBase64: string;
  mime: "image/png" | "image/jpeg" | "image/webp";
  prompt: string;
  /** Max output tokens for the description. Defaults to 1024. */
  maxTokens?: number;
  /**
   * Model to ask. The fallback client fills this in per provider; a direct
   * client call without it fails with a clear error instead of guessing.
   */
  model?: string;
}

export interface VisionResult {
  text: string;
  model: string;
  /** Provider name. Absent on a direct client call, which does not know it. */
  provider?: string;
  /** Token usage, when the provider reports it (for cost accounting). */
  usage?: Usage;
}

export interface LlmClient {
  chat(params: ChatParams): Promise<ChatResult>;
  describeImage?(req: VisionRequest): Promise<VisionResult>;
}

/** An LlmClient that always supports describeImage (the fallback client). */
export interface VisionCapableLlm extends LlmClient {
  describeImage(req: VisionRequest): Promise<VisionResult>;
}

export interface LlmOptions {
  baseURL: string;
  apiKey: string;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Daily :free quota gate (Fase 8). When omitted, the gate resolves from
   * env (BIKININ_WORKSPACE for the counter dir, BIKININ_FREE_DAILY_LIMIT,
   * BIKININ_QUOTA=off to disable) and is ON: the fallback client builds
   * its clients without opts, so env is the only wiring that covers main
   * runs and subagents alike. Tests pass an explicit workspace instead.
   */
  quota?: QuotaClientOptions;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function classify(err: unknown): { retryable: boolean; error: AgentError } {
  if (err instanceof APIUserAbortError) {
    return {
      retryable: false,
      error: new AgentError("provider_error", "Permintaan dibatalkan"),
    };
  }
  if (err instanceof APIConnectionError) {
    return {
      retryable: true,
      error: new AgentError(
        "provider_error",
        "Gagal terhubung ke penyedia (jaringan/timeout)",
        true,
        true,
      ),
    };
  }
  if (err instanceof APIError) {
    const status = err.status;
    if (status === 429) {
      return {
        retryable: true,
        error: new AgentError(
          "rate_limited",
          "Kena rate limit penyedia (429)",
          true,
          true,
        ),
      };
    }
    if (status === 402) {
      return {
        retryable: false,
        error: new AgentError(
          "provider_error",
          "Saldo atau kuota penyedia habis (402)",
          false,
          true,
        ),
      };
    }
    if (status !== undefined && status >= 500) {
      return {
        retryable: true,
        error: new AgentError(
          "provider_error",
          `Penyedia error ${status}`,
          true,
          true,
        ),
      };
    }
    return {
      retryable: false,
      error: new AgentError(
        "provider_error",
        `Penyedia menolak request (${status ?? "tanpa status"})`,
      ),
    };
  }
  return {
    retryable: false,
    error: new AgentError(
      "provider_error",
      err instanceof Error ? err.message : "Error tidak dikenal",
    ),
  };
}

/** True when the provider rejected an image input (not a retryable error). */
function isUnsupportedImageError(err: unknown): boolean {
  if (!(err instanceof APIError)) return false;
  if (err.status !== 400 && err.status !== 422) return false;
  return /image|vision|multimodal/i.test(err.message);
}

/** One vision call costs at most this long; the image plus prompt are small. */
const VISION_TIMEOUT_MS = 60_000;
/** Default description length cap (output tokens). */
const VISION_DEFAULT_MAX_TOKENS = 1024;

export function createOpenAiLlm(opts: LlmOptions): LlmClient {
  const client = new OpenAI({
    baseURL: opts.baseURL,
    apiKey: opts.apiKey,
    timeout: opts.timeoutMs ?? 120_000,
    maxRetries: 0, // retries are handled below so they stay visible and bounded
  });
  const maxRetries = opts.maxRetries ?? 3;
  const sleep = opts.sleep ?? defaultSleep;
  const quota = resolveQuotaClient(opts.quota);

  /**
   * Daily :free quota gate. Runs BEFORE the HTTP request is sent and
   * OUTSIDE the retry try/catch below, so an exhausted pool throws a
   * fallback-eligible error straight to the fallback chain (next provider)
   * instead of being retried or re-wrapped into a generic provider error.
   * Non-free models are never counted.
   */
  function chargeQuota(model: string): void {
    if (!quota.enabled || !isFreeModel(model)) return;
    checkAndRecordFreeRequest(quota.workspace, model, quota.dailyFreeLimit);
  }

  return {
    async chat(p) {
      for (let attempt = 0; ; attempt++) {
        chargeQuota(p.model);
        let received = false;
        try {
          const stream = await client.chat.completions.create(
            {
              model: p.model,
              messages: p.messages,
              ...(p.tools.length > 0 ? { tools: p.tools } : {}),
              stream: true,
              stream_options: { include_usage: true },
            },
            { signal: p.signal },
          );

          let text = "";
          let usage: Usage = {
            input_tokens: 0,
            output_tokens: 0,
            cached_tokens: 0,
          };
          const partial = new Map<
            number,
            { id: string; name: string; args: string }
          >();

          for await (const chunk of stream) {
            received = true;
            if (chunk.usage) {
              usage = {
                input_tokens: chunk.usage.prompt_tokens,
                output_tokens: chunk.usage.completion_tokens,
                cached_tokens:
                  chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
              };
            }
            const delta = chunk.choices[0]?.delta;
            if (!delta) continue;
            if (delta.content) {
              text += delta.content;
              p.onText?.(delta.content);
            }
            for (const tc of delta.tool_calls ?? []) {
              const slot = partial.get(tc.index) ?? {
                id: "",
                name: "",
                args: "",
              };
              if (tc.id) slot.id = tc.id;
              if (tc.function?.name) slot.name += tc.function.name;
              if (tc.function?.arguments) slot.args += tc.function.arguments;
              partial.set(tc.index, slot);
            }
          }

          const toolCalls = [...partial.entries()]
            .sort(([a], [b]) => a - b)
            .filter(([, s]) => s.name !== "")
            .map(([i, s]): ToolCallReq => ({
              id: s.id || `call_${i}`,
              type: "function",
              function: { name: s.name, arguments: s.args || "{}" },
            }));

          return { text, toolCalls, usage };
        } catch (err) {
          if (p.signal?.aborted) throw err;
          const { retryable, error } = classify(err);
          // Only retry when nothing was streamed yet, so text is never duplicated.
          if (retryable && !received && attempt < maxRetries) {
            await sleep(1000 * 2 ** attempt);
            continue;
          }
          throw error;
        }
      }
    },

    async describeImage(req) {
      const model = req.model;
      if (!model) {
        throw new AgentError(
          "provider_error",
          "describeImage butuh model (diisi fallback per provider)",
        );
      }
      for (let attempt = 0; ; attempt++) {
        chargeQuota(model);
        try {
          const res = await client.chat.completions.create(
            {
              model,
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: req.prompt },
                    {
                      type: "image_url",
                      image_url: {
                        url: `data:${req.mime};base64,${req.imageBase64}`,
                      },
                    },
                  ],
                },
              ],
              max_tokens: req.maxTokens ?? VISION_DEFAULT_MAX_TOKENS,
              stream: false,
            },
            { timeout: VISION_TIMEOUT_MS },
          );
          // The SDK types message content as string | null, but some
          // providers return an array of text parts; handle both.
          const raw = res.choices[0]?.message?.content as unknown;
          const text =
            typeof raw === "string"
              ? raw
              : Array.isArray(raw)
                ? raw
                    .filter(
                      (part): part is { type: "text"; text: string } =>
                        typeof part === "object" &&
                        part !== null &&
                        (part as { type?: unknown }).type === "text" &&
                        typeof (part as { text?: unknown }).text === "string",
                    )
                    .map((part) => part.text)
                    .join("")
                : "";
          const usage: Usage = {
            input_tokens: res.usage?.prompt_tokens ?? 0,
            output_tokens: res.usage?.completion_tokens ?? 0,
            cached_tokens: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
          };
          return { text, model, usage };
        } catch (err) {
          // A model that cannot take images must not be retried: the next
          // provider in the fallback chain may support them.
          if (isUnsupportedImageError(err)) {
            throw new AgentError(
              "provider_error",
              `Model ${model} tidak mendukung image input`,
              false,
              true,
            );
          }
          const { retryable, error } = classify(err);
          if (retryable && attempt < maxRetries) {
            await sleep(1000 * 2 ** attempt);
            continue;
          }
          throw error;
        }
      }
    },
  };
}
