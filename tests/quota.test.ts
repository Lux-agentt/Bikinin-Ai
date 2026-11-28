// Daily quota enforcement + data-driven router (Fase 8).
// No live provider keys exist on this VM: every LLM call here goes to a
// fake local OpenAI-compatible server (streaming SSE) or a stub client.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentError } from "../src/errors.js";
import { createEmitter, type AgentEvent } from "../src/events.js";
import {
  createOpenAiLlm,
  type ChatResult,
  type LlmClient,
} from "../src/llm/client.js";
import { createFallbackLlm } from "../src/llm/fallback.js";
import type { ProviderConfig } from "../src/llm/providers.js";
import {
  freeDailyLimit,
  freeQuotaStatus,
  isFreeModel,
  quotaFilePath,
  readQuotaDay,
  utcDay,
} from "../src/llm/quota.js";
import {
  importEvalReport,
  loadRouterStatsSync,
  modelFromEvalLabel,
  recordRouterOutcome,
  routeProviders,
} from "../src/llm/router.js";
import {
  buildLedgerFromEvents,
  loadLedger,
  upsertLedger,
  type RunLedger,
} from "../src/server/ledger.js";

const NORTH = "cohere/north-mini-code:free";
const SUPER = "nvidia/nemotron-3.5-super-vl:free";
const LIGHTNING = "nvidia/nemotron-3.5-lightning:free";
const ERNIE = "baidu/ernie-5.5-flash-preview:free";
const GEMINI = "gemini-4-hydrogen";
const NANO = "z-ai/glm-5.3-flash";

function chain(): ProviderConfig[] {
  const p = (
    name: string,
    model: string,
    baseUrl: string,
    inPerM: number,
    outPerM: number,
  ): ProviderConfig => ({ name, baseUrl, apiKey: "k", model, inPerM, outPerM });
  return [
    p("or-north", NORTH, "https://openrouter.ai/api/v1", 0, 0),
    p("or-supervl", SUPER, "https://openrouter.ai/api/v1", 0, 0),
    p("or-lightning", LIGHTNING, "https://openrouter.ai/api/v1", 0, 0),
    p("or-ernie", ERNIE, "https://openrouter.ai/api/v1", 0, 0),
    p(
      "gemini",
      GEMINI,
      "https://generativelanguage.googleapis.com/v1beta/openai",
      0,
      0,
    ),
    p("nano", NANO, "https://api.nano-gpt.com/api/v1", 0.15, 0.5),
  ];
}

/** Fake OpenAI-compatible server: counts every request, answers chat with SSE. */
async function withFakeServer(
  run: (baseURL: string, hits: () => number) => Promise<void>,
): Promise<void> {
  let hits = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      hits += 1;
      let stream = false;
      try {
        stream = (JSON.parse(raw) as { stream?: unknown }).stream === true;
      } catch {
        stream = false;
      }
      if (stream) {
        const c1 = JSON.stringify({
          id: "c",
          object: "chat.completion.chunk",
          created: 0,
          model: "m:free",
          choices: [
            { index: 0, delta: { content: "halo" }, finish_reason: null },
          ],
        });
        const c2 = JSON.stringify({
          id: "c",
          object: "chat.completion.chunk",
          created: 0,
          model: "m:free",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${c1}\n\ndata: ${c2}\n\ndata: [DONE]\n\n`);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            created: 0,
            model: "m:free",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "gambar: kucing." },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 10,
              total_tokens: 110,
            },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}/v1`, () => hits);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function tmpWs(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "bikinin-quota-"));
  const ws = join(base, "ws");
  await mkdir(ws, { recursive: true });
  return ws;
}

async function seedQuotaFile(
  ws: string,
  used: number,
  limit = 50,
): Promise<void> {
  const day = utcDay();
  await mkdir(join(ws, ".bikinin", "quota"), { recursive: true });
  await writeFile(
    quotaFilePath(ws, day),
    JSON.stringify({
      version: 1,
      date: day,
      free: { used, limit },
      by_model: { [NORTH]: used },
    }),
    "utf8",
  );
}

describe("daily :free counter", () => {
  it("identifies :free models and resolves the limit from env", () => {
    expect(isFreeModel("cohere/north-mini-code:free")).toBe(true);
    expect(isFreeModel("gemini-4-hydrogen")).toBe(false);
    expect(isFreeModel("")).toBe(false);
    expect(isFreeModel(null)).toBe(false);
    expect(freeDailyLimit({})).toBe(50);
    expect(freeDailyLimit({ BIKININ_FREE_DAILY_LIMIT: "10" })).toBe(10);
    expect(freeDailyLimit({ BIKININ_FREE_DAILY_LIMIT: "bukan-angka" })).toBe(
      50,
    );
    expect(freeDailyLimit({}, 3)).toBe(3);
  });

  it("persists counts per UTC day under workspace/.bikinin/quota/", async () => {
    const ws = await tmpWs();
    const day = utcDay();
    expect(utcDay()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(freeQuotaStatus(ws).used).toBe(0);
    expect(freeQuotaStatus(ws).exhausted).toBe(false);
    const { checkAndRecordFreeRequest } = await import("../src/llm/quota.js");
    checkAndRecordFreeRequest(ws, NORTH, 50);
    checkAndRecordFreeRequest(ws, LIGHTNING, 50);
    const file = JSON.parse(await readFile(quotaFilePath(ws, day), "utf8")) as {
      free: { used: number };
      by_model: Record<string, number>;
    };
    expect(file.free.used).toBe(2);
    expect(file.by_model[NORTH]).toBe(1);
    expect(file.by_model[LIGHTNING]).toBe(1);
    // A different UTC day starts at zero.
    expect(readQuotaDay(ws, "2999-01-01").free.used).toBe(0);
    // Non-free models are never counted.
    checkAndRecordFreeRequest(ws, GEMINI, 50);
    expect(freeQuotaStatus(ws).used).toBe(2);
  });
});

describe("client quota gate (no 429 loop)", () => {
  it("refuses the third :free request at limit 2, before any HTTP attempt", async () => {
    const ws = await tmpWs();
    await withFakeServer(async (baseURL, hits) => {
      const llm = createOpenAiLlm({
        baseURL,
        apiKey: "test",
        quota: { workspace: ws, dailyFreeLimit: 2 },
      });
      const chat = () => llm.chat({ model: "m:free", messages: [], tools: [] });
      const r1 = await chat();
      expect(r1.text).toBe("halo");
      await chat();
      expect(hits()).toBe(2);
      let caught: unknown;
      try {
        await chat();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AgentError);
      const e = caught as AgentError;
      expect(e.code).toBe("rate_limited");
      expect(e.fallback).toBe(true);
      expect(e.retryable).toBe(false);
      expect(e.message).toMatch(/Kuota harian OpenRouter :free habis \(2\/2/);
      // The refused request never reached the server: no 429, no retry.
      expect(hits()).toBe(2);
      expect(freeQuotaStatus(ws, 2).used).toBe(2);
    });
  });

  it("does not limit or count non-free models", async () => {
    const ws = await tmpWs();
    await withFakeServer(async (baseURL, hits) => {
      const llm = createOpenAiLlm({
        baseURL,
        apiKey: "test",
        quota: { workspace: ws, dailyFreeLimit: 1 },
      });
      for (let i = 0; i < 3; i++) {
        const r = await llm.chat({
          model: "gemini-4-hydrogen",
          messages: [],
          tools: [],
        });
        expect(r.text).toBe("halo");
      }
      expect(hits()).toBe(3);
      expect(freeQuotaStatus(ws, 1).used).toBe(0);
    });
  });

  it("counts vision calls too, and refuses them when the pool is empty", async () => {
    const ws = await tmpWs();
    await withFakeServer(async (baseURL) => {
      const llm = createOpenAiLlm({
        baseURL,
        apiKey: "test",
        quota: { workspace: ws, dailyFreeLimit: 1 },
      });
      if (!llm.describeImage)
        throw new Error("client tidak punya describeImage");
      const req = {
        imageBase64: "AAAA",
        mime: "image/png" as const,
        prompt: "apa ini?",
        model: "v:free",
      };
      const r = await llm.describeImage(req);
      expect(r.text).toBe("gambar: kucing.");
      expect(freeQuotaStatus(ws, 1).used).toBe(1);
      await expect(llm.describeImage(req)).rejects.toThrow(
        /Kuota harian OpenRouter :free habis/,
      );
    });
  });

  it("BIKININ_QUOTA=off disables the gate", async () => {
    const ws = await tmpWs();
    await withFakeServer(async (baseURL, hits) => {
      const llm = createOpenAiLlm({
        baseURL,
        apiKey: "test",
        quota: { workspace: ws, dailyFreeLimit: 0, enabled: false },
      });
      const r = await llm.chat({ model: "m:free", messages: [], tools: [] });
      expect(r.text).toBe("halo");
      expect(hits()).toBe(1);
    });
  });
});

describe("fallback switches provider or stops honestly", () => {
  const stubOk = (text: string): ChatResult => ({
    text,
    toolCalls: [],
    usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0 },
  });

  it("moves to the next provider with quota when :free is exhausted", async () => {
    const ws = await tmpWs();
    await withFakeServer(async (baseURL, hits) => {
      const free: ProviderConfig = {
        name: "or-north",
        baseUrl: baseURL,
        apiKey: "test",
        model: "m:free",
        inPerM: 0,
        outPerM: 0,
      };
      const gemini: ProviderConfig = {
        name: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        apiKey: "test",
        model: GEMINI,
        inPerM: 0,
        outPerM: 0,
      };
      const llm = createFallbackLlm([free, gemini], {
        makeClient: (p): LlmClient =>
          p.name === "gemini"
            ? {
                async chat() {
                  return stubOk("dari gemini");
                },
              }
            : createOpenAiLlm({
                baseURL: p.baseUrl,
                apiKey: p.apiKey,
                quota: { workspace: ws, dailyFreeLimit: 1 },
              }),
      });
      const chat = () =>
        llm.chat({ model: "ignored", messages: [], tools: [] });
      const r1 = await chat();
      expect(r1.text).toBe("halo");
      expect(r1.model).toBe("m:free");
      expect(hits()).toBe(1);
      // Pool empty: the next chat must NOT hit the free server again.
      const r2 = await chat();
      expect(r2.text).toBe("dari gemini");
      expect(r2.model).toBe(GEMINI);
      expect(hits()).toBe(1);
    });
  });

  it("stops honestly with zero further HTTP attempts when every provider is :free and the pool is empty", async () => {
    const ws = await tmpWs();
    await withFakeServer(async (baseURL, hits) => {
      const mk = (name: string): ProviderConfig => ({
        name,
        baseUrl: baseURL,
        apiKey: "test",
        model: "m:free",
        inPerM: 0,
        outPerM: 0,
      });
      const llm = createFallbackLlm([mk("free-a"), mk("free-b")], {
        makeClient: (p): LlmClient =>
          createOpenAiLlm({
            baseURL: p.baseUrl,
            apiKey: p.apiKey,
            quota: { workspace: ws, dailyFreeLimit: 1 },
          }),
      });
      const chat = () =>
        llm.chat({ model: "ignored", messages: [], tools: [] });
      await chat();
      expect(hits()).toBe(1);
      let caught: unknown;
      try {
        await chat();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AgentError);
      expect((caught as AgentError).code).toBe("rate_limited");
      expect((caught as AgentError).message).toMatch(/Kuota harian/);
      expect(hits()).toBe(1);
    });
  });
});

describe("data-driven router", () => {
  it("changes its decision after recorded outcomes exist", async () => {
    const ws = await tmpWs();
    // Heuristic for light tasks: Lightning. Record Lightning losing and
    // Ernie winning in "light" — the router must flip to Ernie.
    expect(
      routeProviders(chain(), "halo", { stats: null }).providers[0]?.model,
    ).toBe(LIGHTNING);
    for (let i = 0; i < 4; i++) {
      await recordRouterOutcome(ws, {
        model: LIGHTNING,
        category: "light",
        won: false,
      });
      await recordRouterOutcome(ws, {
        model: ERNIE,
        category: "light",
        won: true,
      });
    }
    const { providers, route } = routeProviders(chain(), "halo", {
      workspace: ws,
    });
    expect(providers[0]?.model).toBe(ERNIE);
    expect(route.reason).toMatch(/data router/);
    expect(route.reason).toMatch(/4\/4/);
  });

  it("keeps the heuristic when data is below the sample threshold", async () => {
    const ws = await tmpWs();
    for (let i = 0; i < 2; i++) {
      await recordRouterOutcome(ws, {
        model: ERNIE,
        category: "light",
        won: true,
      });
    }
    const { providers, route } = routeProviders(chain(), "halo", {
      workspace: ws,
    });
    expect(providers[0]?.model).toBe(LIGHTNING);
    expect(route.reason).not.toMatch(/data router/);
  });

  it("BIKININ_ROUTER=off still returns the original order even with data", async () => {
    const ws = await tmpWs();
    for (let i = 0; i < 4; i++) {
      await recordRouterOutcome(ws, {
        model: ERNIE,
        category: "light",
        won: true,
      });
    }
    const { providers, route } = routeProviders(chain(), "halo", {
      enabled: false,
      workspace: ws,
    });
    expect(providers.map((p) => p.model)).toEqual(chain().map((p) => p.model));
    expect(route.reason).toMatch(/nonaktif/);
  });

  it("skips an exhausted :free pick for the next provider with quota", async () => {
    const ws = await tmpWs();
    await seedQuotaFile(ws, 50, 50);
    const { providers, route } = routeProviders(chain(), "buatkan website", {
      workspace: ws,
    });
    expect(providers[0]?.model).toBe(GEMINI);
    expect(route.reason).toMatch(/kuota :free habis \(50\/50/);
    // An all-:free chain keeps its order; the client stops it honestly.
    const freeOnly = chain().slice(0, 4);
    const kept = routeProviders(freeOnly, "buatkan website", {
      workspace: ws,
    });
    expect(kept.providers.map((p) => p.model)).toEqual(
      freeOnly.map((p) => p.model),
    );
  });

  it("imports eval logs into the win table, idempotently", async () => {
    const ws = await tmpWs();
    expect(modelFromEvalLabel("or-north (cohere/north-mini-code:free)")).toBe(
      NORTH,
    );
    expect(modelFromEvalLabel("dummy (scripted)")).toBe("scripted");
    expect(modelFromEvalLabel("plain-model-name")).toBe("plain-model-name");
    const report = {
      model: `or-north (${NORTH})`,
      startedAt: "2026-11-18T00:00:00.000Z",
      results: [
        { id: "t1", category: "bugfix", status: "pass" as const },
        { id: "t2", category: "bugfix", status: "pass" as const },
        { id: "t3", category: "bugfix", status: "pass" as const },
        { id: "t4", category: "bugfix", status: "fail" as const },
        { id: "t5", category: "research", status: "skip" as const },
        { id: "t6", category: "behavior", status: "pass" as const },
      ],
    };
    expect(await importEvalReport(ws, report)).toBe(5);
    const stats = loadRouterStatsSync(ws);
    expect(stats?.outcomes.coding?.[NORTH]).toEqual({ win: 3, loss: 1 });
    expect(stats?.outcomes.general?.[NORTH]).toEqual({ win: 1, loss: 0 });
    expect(stats?.outcomes.reasoning).toBeUndefined();
    // Re-importing the same log records nothing new.
    expect(await importEvalReport(ws, report)).toBe(0);
    expect(loadRouterStatsSync(ws)?.outcomes.coding?.[NORTH]).toEqual({
      win: 3,
      loss: 1,
    });
  });
});

describe("ledger quota snapshot + router outcome", () => {
  function fakeRunEvents(status: "completed" | "error"): AgentEvent[] {
    const events: AgentEvent[] = [];
    const emit = createEmitter("run_quota01", (e) => events.push(e));
    emit("run_started", {
      session_id: "s_quota001",
      model: NORTH,
      effort: "sedang",
      user_message: "buatkan website",
      limits: { max_cost_usd: 1 },
      route: {
        category: "coding",
        reason: 'tugas coding (kata kunci: "website")',
        preferred_model: NORTH,
      },
    });
    emit("usage", {
      step: 1,
      input_tokens: 100,
      output_tokens: 20,
      cached_tokens: 0,
      cost_usd: 0,
      totals: {
        steps: 1,
        input_tokens: 100,
        output_tokens: 20,
        cached_tokens: 0,
        cost_usd: 0,
      },
    });
    emit("run_finished", {
      status,
      summary: status === "completed" ? "Selesai." : "Gagal.",
      totals: {
        steps: 1,
        input_tokens: 100,
        output_tokens: 20,
        cached_tokens: 0,
        cost_usd: 0,
      },
      duration_ms: 100,
      resumable: false,
    });
    return events;
  }

  it("attaches the day's :free snapshot and records the outcome once", async () => {
    const ws = await tmpWs();
    await seedQuotaFile(ws, 7, 50);
    const ledger = buildLedgerFromEvents(
      fakeRunEvents("completed"),
      "run_quota01",
    ) as RunLedger;
    expect(ledger.category).toBe("coding");
    await upsertLedger(ws, "s_quota001", ledger);
    const loaded = await loadLedger(ws, "s_quota001");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.quota).toEqual({
      date: utcDay(),
      free_used: 7,
      free_limit: 50,
    });
    expect(loaded[0]?.category).toBe("coding");
    expect(loadRouterStatsSync(ws)?.outcomes.coding?.[NORTH]).toEqual({
      win: 1,
      loss: 0,
    });
    // Upserting the same finished run again does not double-count it.
    await upsertLedger(ws, "s_quota001", ledger);
    expect(loadRouterStatsSync(ws)?.outcomes.coding?.[NORTH]).toEqual({
      win: 1,
      loss: 0,
    });
  });

  it("records a failed run as a loss and attaches no quota when no :free request happened today", async () => {
    const ws = await tmpWs();
    const ledger = buildLedgerFromEvents(
      fakeRunEvents("error"),
      "run_quota01",
    ) as RunLedger;
    await upsertLedger(ws, "s_quota001", ledger);
    const loaded = await loadLedger(ws, "s_quota001");
    expect(loaded[0]?.quota).toBeUndefined();
    expect(loadRouterStatsSync(ws)?.outcomes.coding?.[NORTH]).toEqual({
      win: 0,
      loss: 1,
    });
  });
});
