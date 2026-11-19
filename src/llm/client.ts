// OpenAI-compatible chat client: streaming, tool calls, bounded retry (429/5xx/network), timeout.
// Base URL, key and model always come from config. Nothing is hardcoded here.
import OpenAI, {
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
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
  /**
   * Opaque Gemini thought signature, echoed back verbatim on the next
   * request (Google's OpenAI-compat layer 400s a replayed function call
   * without it). Never logged, never branched on, never asserted by
   * value — only round-tripped. Absent for providers that don't issue one.
   */
  thoughtSignature?: string;
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
  /**
   * Opaque Gemini thought signature for THIS turn's text, carried on the
   * assistant message itself (extra_content.google.thought_signature). A
   * turn that mixes text and tool calls 400s on the next request without
   * it. Never logged, never branched on — only round-tripped.
   */
  messageThoughtSignature?: string;
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

let generatedCallId = 0;

/** Provider's own error detail, truncated — a bare status makes 400s
 *  undiagnosable (live eval Gemini 2026-11-18: the first request was
 *  accepted, a later one 400'd, and the body was discarded). */
function providerDetail(err: APIError): string {
  const msg = typeof err.message === "string" ? err.message.trim() : "";
  if (!msg) return "";
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}

function classify(
  err: unknown,
  shape?: string,
): { retryable: boolean; error: AgentError } {
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
    const detail = providerDetail(err);
    const withDetail = (base: string) =>
      detail ? `${base}: ${detail}` : base;
    if (status === 429) {
      return {
        retryable: true,
        error: new AgentError(
          "rate_limited",
          withDetail("Kena rate limit penyedia (429)"),
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
          withDetail("Saldo atau kuota penyedia habis (402)"),
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
          withDetail(`Penyedia error ${status}`),
          true,
          true,
        ),
      };
    }
    if (status === 400 && /thought_signature/i.test(err.message)) {
      // Live run 2026-11-19: Gemini 400'd a replayed update_plan call
      // because the model never attached a thought_signature to it
      // (fingerprint sig:0 — nothing was captured to echo). Retrying
      // Gemini with the same history 400s again, but the next provider
      // does not validate signatures, so fall over instead of killing
      // the run.
      return {
        retryable: false,
        error: new AgentError(
          "provider_error",
          withDetail("Penyedia menolak request (400)") +
            (shape ? ` | riwayat: ${shape}` : ""),
          false,
          true,
        ),
      };
    }
    return {
      retryable: false,
      error: new AgentError(
        "provider_error",
        withDetail(`Penyedia menolak request (${status ?? "tanpa status"})`) +
          (shape ? ` | riwayat: ${shape}` : ""),
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

/** Gemini thought signature from a streamed tool-call or message delta,
 *  if present. Google's OpenAI-compat layer sends it as
 *  `extra_content.google.thought_signature` (a flat `thought_signature`
 *  is accepted too). Live eval 2026-11-19 showed the message-level
 *  signature never arrives on streamed deltas, so also accept the
 *  camelCase key inside `google` and an array-shaped `extra_content` —
 *  cheap tolerance for a field whose exact wire shape is undocumented.
 *  Opaque: carried verbatim, never inspected. */
function readThoughtSignature(tc: unknown): string | undefined {
  if (!tc || typeof tc !== "object") return undefined;
  const raw = (tc as { extra_content?: unknown }).extra_content;
  const extras = Array.isArray(raw) ? raw : [raw];
  for (const extra of extras) {
    const google = (
      extra as { google?: Record<string, unknown> } | null | undefined
    )?.google;
    if (!google || typeof google !== "object") continue;
    const sig = google.thought_signature ?? google.thoughtSignature;
    if (typeof sig === "string" && sig) return sig;
  }
  const flat = tc as {
    thought_signature?: unknown;
    thoughtSignature?: unknown;
  };
  if (typeof flat.thought_signature === "string" && flat.thought_signature)
    return flat.thought_signature;
  if (typeof flat.thoughtSignature === "string" && flat.thoughtSignature)
    return flat.thoughtSignature;
  return undefined;
}

/**
 * Tool calls as echoed back in history. A Gemini-issued thought
 * signature rides in `extra_content.google.thought_signature` — the
 * location Google's own OpenAI-compatibility layer uses. Other
 * providers never see it: createOpenAiLlm strips extra_content from
 * outgoing messages unless the base URL is Gemini's.
 */
export function echoToolCalls(
  calls: ToolCallReq[],
): ChatCompletionMessageToolCall[] {
  return calls.map((c) => {
    const base = { id: c.id, type: "function" as const, function: c.function };
    if (!c.thoughtSignature) return base;
    return {
      ...base,
      extra_content: { google: { thought_signature: c.thoughtSignature } },
    };
  }) as ChatCompletionMessageToolCall[];
}

/**
 * The assistant message as echoed back in history. Besides the tool-call
 * signatures (see echoToolCalls), a thinking model's TEXT also carries a
 * signature — on the message itself. A turn that mixes text and tool calls
 * 400s on the next request without it (live eval Gemini 2026-11-18:
 * edge-missing-file, edge-unicode — the provider only says "Request
 * contains an invalid argument", so the shape, not the message, pointed
 * at the missing turn signature).
 *
 * No tool calls in this turn means NO `tool_calls` key at all — not an
 * empty array. Live eval 2026-11-19: both edge tasks still 400'd with
 * tool signatures present but no message signature ever captured, and
 * the pure-text turns in between were echoed as `tool_calls: []`;
 * a strict validator may reject the empty array, so it is omitted.
 */
export function echoAssistantMessage(res: ChatResult): ChatMessage {
  const msg: ChatMessage = {
    role: "assistant",
    content: res.text || "",
    ...(res.toolCalls.length > 0
      ? { tool_calls: echoToolCalls(res.toolCalls) }
      : {}),
  };
  if (!res.messageThoughtSignature) return msg;
  return {
    ...msg,
    extra_content: { google: { thought_signature: res.messageThoughtSignature } },
  } as ChatMessage;
}

function isGeminiBaseUrl(baseURL: string): boolean {
  return baseURL.includes("generativelanguage.googleapis.com");
}

/** Compact shape of the outgoing history, attached to generic 400s so the
 *  eval log can say WHICH turn was invalid (the provider only says
 *  "Request contains an invalid argument"). Structure only, no content. */
function shapeSummary(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      if (m.role !== "assistant") return m.role;
      const toolCalls =
        "tool_calls" in m && Array.isArray(m.tool_calls) ? m.tool_calls : [];
      const sigs = toolCalls.filter(
        (tc) => "extra_content" in (tc as unknown as Record<string, unknown>),
      ).length;
      const hasText =
        typeof m.content === "string" && m.content.length > 0;
      const msgSig =
        "extra_content" in (m as unknown as Record<string, unknown>) ? 1 : 0;
      return `asst{${hasText ? "text" : "notext"},tools:${toolCalls.length},sig:${sigs},msgsig:${msgSig}}`;
    })
    .join(",");
}

/**
 * Gemini's OpenAI-compat layer rejects an assistant message that pairs
 * tool_calls with an empty-string content. Live eval 2026-11-19
 * (log 2026-11-19-051358693.json): edge-missing-file 400'd on a history
 * of two TEXTLESS tool-call turns — both with tool signatures present,
 * no message signature anywhere — while the same shape passed on Nano
 * and research tasks (whose turns carry text) passed on Gemini. The
 * empty string is the remaining difference, so for Gemini-bound
 * requests it is sent as null instead (the OpenAI type allows null for
 * tool-only turns). Non-Gemini providers keep "" because some of them
 * reject null (see echoAssistantMessage).
 */
function normalizeForGemini(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (
      m.role !== "assistant" ||
      !("tool_calls" in m) ||
      !m.tool_calls ||
      m.content !== ""
    )
      return m;
    return { ...m, content: null } as ChatMessage;
  });
}

/**
 * Drop provider-opaque fields from echoed assistant messages when talking
 * to a non-Gemini provider — strict providers reject requests carrying
 * extra_content. Gemini requests pass through untouched.
 */
function stripForeignExtraContent(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== "assistant") return m;
    const copy = { ...m } as unknown as Record<string, unknown>;
    delete copy.extra_content;
    if ("tool_calls" in m && Array.isArray(m.tool_calls)) {
      copy.tool_calls = m.tool_calls.map((tc) =>
        tc.type === "function"
          ? { id: tc.id, type: "function" as const, function: tc.function }
          : tc,
      );
    }
    return copy as unknown as ChatMessage;
  });
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
              messages: isGeminiBaseUrl(opts.baseURL)
                ? normalizeForGemini(p.messages)
                : stripForeignExtraContent(p.messages),
              ...(p.tools.length > 0 ? { tools: p.tools } : {}),
              stream: true,
              stream_options: { include_usage: true },
            },
            { signal: p.signal },
          );

          let text = "";
          // Turn-level thought signature, if the model attached one to
          // this response's text (see ChatResult.messageThoughtSignature).
          let messageThoughtSignature: string | undefined;
          let usage: Usage = {
            input_tokens: 0,
            output_tokens: 0,
            cached_tokens: 0,
          };
          const partial = new Map<
            number,
            { id: string; name: string; args: string; thoughtSignature?: string }
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
            // A thinking model signs the text turn itself too; the
            // signature rides on the message delta's extra_content.
            const msgSig = readThoughtSignature(delta);
            if (msgSig) messageThoughtSignature = msgSig;
            for (const tc of delta.tool_calls ?? []) {
              const slot = partial.get(tc.index) ?? {
                id: "",
                name: "",
                args: "",
              };
              if (tc.id) slot.id = tc.id;
              if (tc.function?.name) slot.name += tc.function.name;
              if (tc.function?.arguments) slot.args += tc.function.arguments;
              const sig = readThoughtSignature(tc);
              if (sig) slot.thoughtSignature = sig;
              partial.set(tc.index, slot);
            }
          }

          const toolCalls = [...partial.entries()]
            .sort(([a], [b]) => a - b)
            .filter(([, s]) => s.name !== "")
            .map(([i, s]): ToolCallReq => ({
              id: s.id || `call_bikinin_${generatedCallId++}_${i}`,
              type: "function",
              function: { name: s.name, arguments: s.args || "{}" },
              ...(s.thoughtSignature
                ? { thoughtSignature: s.thoughtSignature }
                : {}),
            }));

          return {
            text,
            toolCalls,
            usage,
            ...(messageThoughtSignature ? { messageThoughtSignature } : {}),
          };
        } catch (err) {
          if (p.signal?.aborted) throw err;
          const { retryable, error } = classify(err, shapeSummary(p.messages));
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
