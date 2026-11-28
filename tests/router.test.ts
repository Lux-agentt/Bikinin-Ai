// Model router (Fase 7, Track C): category -> first model, explicit model
// wins, router-off keeps the config order, fallback chain stays a permutation.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentEvent, RunStarted } from "../src/events.js";
import { createFallbackLlm } from "../src/llm/fallback.js";
import type { ChatResult, LlmClient } from "../src/llm/client.js";
import type { ProviderConfig } from "../src/llm/providers.js";
import { quotaFilePath, utcDay } from "../src/llm/quota.js";
import {
  classifyTask,
  isRouterEnabled,
  recordRouterOutcome,
  routeProviders,
} from "../src/llm/router.js";
import { RunManager } from "../src/server/runs.js";
import type { Config } from "../src/config.js";
import { AgentError } from "../src/errors.js";

/** The real configured chain from .env.example (keys redacted, prices real). */
function chain(): ProviderConfig[] {
  const p = (
    name: string,
    model: string,
    baseUrl: string,
    inPerM: number,
    outPerM: number,
  ): ProviderConfig => ({ name, baseUrl, apiKey: "k", model, inPerM, outPerM });
  return [
    p(
      "or-north",
      "cohere/north-mini-code:free",
      "https://openrouter.ai/api/v1",
      0,
      0,
    ),
    p(
      "or-supervl",
      "nvidia/nemotron-3.5-super-vl:free",
      "https://openrouter.ai/api/v1",
      0,
      0,
    ),
    p(
      "or-lightning",
      "nvidia/nemotron-3.5-lightning:free",
      "https://openrouter.ai/api/v1",
      0,
      0,
    ),
    p(
      "or-ernie",
      "baidu/ernie-5.5-flash-preview:free",
      "https://openrouter.ai/api/v1",
      0,
      0,
    ),
    p(
      "gemini",
      "gemini-4-hydrogen",
      "https://generativelanguage.googleapis.com/v1beta/openai",
      0,
      0,
    ),
    p(
      "nano",
      "z-ai/glm-5.3-flash",
      "https://api.nano-gpt.com/api/v1",
      0.15,
      0.5,
    ),
  ];
}

const NORTH = "cohere/north-mini-code:free";
const SUPER = "nvidia/nemotron-3.5-super-vl:free";
const LIGHTNING = "nvidia/nemotron-3.5-lightning:free";

describe("classifyTask", () => {
  it.each([
    ["buatkan landing page kedai kopi dengan HTML dan CSS", "coding"],
    ["perbaiki bug di file index.html", "coding"],
    ["tulis fungsi python untuk sorting", "coding"],
    ["buatkan website lalu deploy ke Cloudflare", "coding"],
    ["bandingkan arsitektur monolith vs microservices", "reasoning"],
    ["analisis kelebihan dan kekurangan rencana ini", "reasoning"],
    ["buatkan rencana bisnis dan beri rekomendasi", "reasoning"],
    ["jelaskan mengapa harga naik bulan ini", "reasoning"],
    ["halo, apa kabar?", "light"],
    ["berapa 2+2?", "light"],
    ["jelaskan apa itu inflasi", "light"],
    ["lanjutkan", "light"],
    ["simpan catatan ini baik-baik", "general"],
  ])("classifies %q as %s", (message, category) => {
    expect(classifyTask(message).category).toBe(category);
  });

  it("is deterministic", () => {
    const msg = "buatkan website dan bandingkan dua desain";
    expect(classifyTask(msg)).toEqual(classifyTask(msg));
  });

  it("coding nouns beat reasoning words, bare verbs lose to reasoning", () => {
    // "bandingkan" + "website": the code noun wins (the task is about code).
    expect(classifyTask("bandingkan website A dan website B").category).toBe(
      "coding",
    );
    // "buatkan" + "rencana": the reasoning noun wins over the bare verb.
    expect(classifyTask("buatkan rencana bisnis").category).toBe("reasoning");
  });
});

describe("isRouterEnabled", () => {
  it.each([undefined, "on", "ON", "yes", "", "  off  "])(
    "treats %s as on/off correctly",
    (v) => {
      // "" and "  off  " are the only tricky ones: "" -> on, "  off  " -> off.
      expect(isRouterEnabled(v as string | undefined)).toBe(
        v?.trim().toLowerCase() !== "off",
      );
    },
  );
  it("turns off only on off/false/0", () => {
    for (const v of ["off", "false", "0", "OFF", "False"]) {
      expect(isRouterEnabled(v)).toBe(false);
    }
    for (const v of ["on", "true", "1", "yes"]) {
      expect(isRouterEnabled(v)).toBe(true);
    }
  });
});

describe("routeProviders", () => {
  it("routes coding to North Mini Code, rest in original order", () => {
    const { providers, route } = routeProviders(
      chain(),
      "buatkan landing page kedai kopi",
    );
    expect(route.category).toBe("coding");
    expect(route.preferred_model).toBe(NORTH);
    expect(providers.map((p) => p.model)).toEqual([
      NORTH,
      SUPER,
      LIGHTNING,
      "baidu/ernie-5.5-flash-preview:free",
      "gemini-4-hydrogen",
      "z-ai/glm-5.3-flash",
    ]);
  });

  it("routes reasoning to the Super model", () => {
    const { providers, route } = routeProviders(
      chain(),
      "bandingkan dua strategi dan beri rekomendasi",
    );
    expect(route.category).toBe("reasoning");
    expect(route.preferred_model).toBe(SUPER);
    expect(providers[0].model).toBe(SUPER);
  });

  it("routes light tasks to the fastest model", () => {
    const { providers, route } = routeProviders(chain(), "berapa 2+2?");
    expect(route.category).toBe("light");
    expect(route.preferred_model).toBe(LIGHTNING);
    expect(providers[0].model).toBe(LIGHTNING);
  });

  it("keeps the config order for general tasks", () => {
    const original = chain();
    const { providers, route } = routeProviders(
      original,
      "simpan catatan ini baik-baik",
    );
    expect(route.category).toBe("general");
    expect(providers.map((p) => p.model)).toEqual(original.map((p) => p.model));
  });

  it("is a permutation: the fallback chain keeps every provider", () => {
    for (const msg of [
      "buatkan website",
      "bandingkan A dan B",
      "halo",
      "simpan catatan ini",
    ]) {
      const { providers } = routeProviders(chain(), msg);
      expect([...providers.map((p) => p.model)].sort()).toEqual(
        [...chain().map((p) => p.model)].sort(),
      );
    }
  });

  it("router-off returns the original order with a disabled reason", () => {
    const original = chain();
    const { providers, route } = routeProviders(chain(), "buatkan website", {
      enabled: false,
    });
    expect(providers.map((p) => p.model)).toEqual(original.map((p) => p.model));
    expect(route.category).toBe("general");
    expect(route.preferred_model).toBe(NORTH);
    expect(route.reason).toMatch(/nonaktif/);
  });

  it("an explicit model always wins over the router", () => {
    const { providers, route } = routeProviders(
      chain(),
      "buatkan landing page kedai kopi",
      { explicitModel: "gemini-4-hydrogen" },
    );
    expect(providers[0].model).toBe("gemini-4-hydrogen");
    expect(route.preferred_model).toBe("gemini-4-hydrogen");
    expect(route.reason).toMatch(/eksplisit/);
  });

  it("an unknown explicit model is ignored and the router decides", () => {
    const { providers, route } = routeProviders(
      chain(),
      "buatkan landing page kedai kopi",
      { explicitModel: "tidak-ada-model" },
    );
    expect(providers[0].model).toBe(NORTH);
    expect(route.category).toBe("coding");
  });

  it("falls back to cheapest for light tasks when no model advertises speed", () => {
    const ps: ProviderConfig[] = [
      {
        name: "dear",
        baseUrl: "https://x.test/v1",
        apiKey: "k",
        model: "big-model",
        inPerM: 5,
        outPerM: 10,
      },
      {
        name: "cheap",
        baseUrl: "https://x.test/v1",
        apiKey: "k",
        model: "small-model",
        inPerM: 0.1,
        outPerM: 0.2,
      },
    ];
    const { providers } = routeProviders(ps, "halo");
    expect(providers[0].model).toBe("small-model");
  });

  it("falls back to priciest for reasoning when no model advertises strength", () => {
    const ps: ProviderConfig[] = [
      {
        name: "cheap",
        baseUrl: "https://x.test/v1",
        apiKey: "k",
        model: "small-model",
        inPerM: 0.1,
        outPerM: 0.2,
      },
      {
        name: "dear",
        baseUrl: "https://x.test/v1",
        apiKey: "k",
        model: "big-model",
        inPerM: 5,
        outPerM: 10,
      },
    ];
    const { providers } = routeProviders(ps, "bandingkan A dan B");
    expect(providers[0].model).toBe("big-model");
  });

  it("works with a single provider and rejects an empty list", () => {
    const one = chain().slice(0, 1);
    expect(routeProviders(one, "buatkan website").providers).toEqual(one);
    expect(() => routeProviders([], "halo")).toThrow("daftar provider kosong");
  });

  it("feeds the routed order into the fallback chain", async () => {
    const tried: string[] = [];
    const usage = { input_tokens: 10, output_tokens: 5, cached_tokens: 0 };
    const ok = (text: string): ChatResult => ({ text, toolCalls: [], usage });
    const llm = createFallbackLlm(
      routeProviders(chain(), "buatkan website").providers,
      {
        makeClient: (p): LlmClient => ({
          async chat(params) {
            tried.push(p.name);
            if (params.model === NORTH)
              throw new AgentError("rate_limited", "429", true, true);
            return ok("dari supervl");
          },
        }),
      },
    );
    const r = await llm.chat({ model: "ignored", messages: [], tools: [] });
    expect(r.text).toBe("dari supervl");
    // Routed model tried first, then the next in the (reordered) chain.
    expect(tried).toEqual(["or-north", "or-supervl"]);
  });
});

describe("RunStarted route field", () => {
  it("accepts a route and stays backward compatible without one", () => {
    const base = {
      v: 1 as const,
      seq: 0,
      ts: new Date().toISOString(),
      run_id: "run_x",
      type: "run_started" as const,
      session_id: "s_01",
      model: NORTH,
      effort: "sedang" as const,
      user_message: "buatkan website",
      limits: { max_cost_usd: 0.5 },
    };
    expect(() =>
      RunStarted.parse({
        ...base,
        route: {
          category: "coding",
          reason: 'tugas coding (kata kunci: "website")',
          preferred_model: NORTH,
        },
      }),
    ).not.toThrow();
    expect(() => RunStarted.parse(base)).not.toThrow();
    expect(() =>
      AgentEvent.parse({ ...base, route: { category: "nope" } }),
    ).toThrow();
  });
});

describe("RunManager routing (integration)", () => {
  const usage = { input_tokens: 100, output_tokens: 20, cached_tokens: 0 };
  const finalText = (text: string): ChatResult => ({
    text,
    toolCalls: [],
    usage,
  });

  async function bootManager(
    providers: ProviderConfig[],
    cfgOverride: Partial<Config> = {},
  ) {
    const base = await mkdtemp(join(tmpdir(), "bikinin-router-"));
    const workspace = join(base, "ws");
    await mkdir(workspace, { recursive: true });
    const manager = new RunManager(
      {
        providers,
        BIKININ_USD_IDR: 17000,
        BIKININ_MAX_COST_USD: 1,
        BIKININ_WORKSPACE: "./workspace",
        BIKININ_MAX_VIDEO_SECONDS: 30,
        ...cfgOverride,
      },
      {
        workspace,
        systemPrompt: "sys",
        llm: {
          async chat(p) {
            p.onText?.("selesai");
            return finalText("selesai");
          },
        },
      },
    );
    return manager;
  }

  async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
    const start = Date.now();
    for (;;) {
      if (cond()) return;
      if (Date.now() - start > ms) throw new Error("timeout menunggu run");
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it("records route on run_started and uses the routed provider", async () => {
    const manager = await bootManager(chain());
    const { run_id } = manager.start({
      message: "buatkan landing page kedai kopi",
      attachment_ids: [],
      effort: "sedang",
    });
    const rec = manager.get(run_id)!;
    await waitFor(() => rec.finished);
    const started = rec.events[0];
    expect(started.type).toBe("run_started");
    if (started.type !== "run_started") throw new Error("bukan run_started");
    expect(started.route?.category).toBe("coding");
    expect(started.route?.preferred_model).toBe(NORTH);
    expect(started.model).toBe(NORTH);
    expect(rec.provider.model).toBe(NORTH);
  });

  it("router-off keeps the first configured provider", async () => {
    const manager = await bootManager(chain(), { BIKININ_ROUTER: "off" });
    const { run_id } = manager.start({
      message: "buatkan landing page kedai kopi",
      attachment_ids: [],
      effort: "sedang",
    });
    const rec = manager.get(run_id)!;
    await waitFor(() => rec.finished);
    const started = rec.events[0];
    if (started.type !== "run_started") throw new Error("bukan run_started");
    expect(started.model).toBe(NORTH);
    expect(started.route?.category).toBe("general");
    expect(started.route?.reason).toMatch(/nonaktif/);
  });

  it("an explicit model wins over the router in the server too", async () => {
    const manager = await bootManager(chain());
    const { run_id } = manager.start({
      message: "buatkan landing page kedai kopi",
      model: "gemini-4-hydrogen",
      attachment_ids: [],
      effort: "sedang",
    });
    const rec = manager.get(run_id)!;
    await waitFor(() => rec.finished);
    const started = rec.events[0];
    if (started.type !== "run_started") throw new Error("bukan run_started");
    expect(started.model).toBe("gemini-4-hydrogen");
    expect(started.route?.preferred_model).toBe("gemini-4-hydrogen");
  });
});

describe("data-driven routing + quota skip (Fase 8)", () => {
  const ERNIE = "baidu/ernie-5.5-flash-preview:free";

  async function tmpWs(): Promise<string> {
    const base = await mkdtemp(join(tmpdir(), "bikinin-router8-"));
    const ws = join(base, "ws");
    await mkdir(ws, { recursive: true });
    return ws;
  }

  it("picks the measured winner over the heuristic once data exists", async () => {
    const ws = await tmpWs();
    // Heuristic for light tasks is Lightning; record it losing and Ernie
    // winning 4/4 in "light".
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
  });

  it("router-off ignores recorded data and keeps the config order", async () => {
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

  it("moves a coding run to Gemini when the :free pool is exhausted", async () => {
    const ws = await tmpWs();
    await mkdir(join(ws, ".bikinin", "quota"), { recursive: true });
    await writeFile(
      quotaFilePath(ws, utcDay()),
      JSON.stringify({
        version: 1,
        date: utcDay(),
        free: { used: 50, limit: 50 },
        by_model: {},
      }),
      "utf8",
    );
    const { providers, route } = routeProviders(
      chain(),
      "buatkan landing page",
      { workspace: ws },
    );
    expect(providers[0]?.model).toBe("gemini-4-hydrogen");
    expect(route.reason).toMatch(/kuota :free habis/);
  });
});
