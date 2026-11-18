import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatCompletionMessageParam as Msg } from "openai/resources/chat/completions";
import { isMemoryModelExtractEnabled } from "../src/config.js";
import { SessionHistory } from "../src/agent/history.js";
import {
  buildMemoryContext,
  collectImplicitCandidates,
  containsSecret,
  extractFacts,
  extractImplicitFacts,
  extractImplicitPreferences,
  formatMemory,
  isFreeModel,
  MEMORY_INJECT_BUDGET,
  mergeFacts,
  parseImplicitFacts,
  parseMemory,
  selectMemoryEntries,
  type FreshFact,
} from "../src/agent/memory.js";
import {
  appendMemoryFacts,
  loadSessions,
  memoryFilePath,
  pruneSessions,
  readMemoryEntries,
  saveSession,
  sessionFilePath,
  type PersistedSession,
} from "../src/server/persistence.js";

const user = (content: string): Msg => ({ role: "user", content });
const asst = (content: string): Msg => ({ role: "assistant", content });

function persisted(id: string, updatedAt: number): PersistedSession {
  return {
    version: 1,
    session_id: id,
    title: "t",
    prompts: 1,
    runs: 1,
    last_status: "completed",
    updated_at: updatedAt,
    history: [[user("halo")]],
  };
}

describe("SessionHistory disk round-trip", () => {
  it("serializes and restores runs in order", () => {
    const h = new SessionHistory();
    h.add([user("satu"), asst("A")]);
    h.add([user("dua"), asst("B")]);
    const restored = SessionHistory.fromJSON(h.toJSON());
    expect(restored.messages().map((m) => m.content)).toEqual([
      "satu",
      "A",
      "dua",
      "B",
    ]);
    expect(restored.runCount).toBe(2);
  });

  it("drops corrupt data instead of throwing", () => {
    expect(SessionHistory.fromJSON(null).runCount).toBe(0);
    expect(SessionHistory.fromJSON("bukan json").runCount).toBe(0);
    expect(
      SessionHistory.fromJSON([{ role: "alien", content: "x" }]).runCount,
    ).toBe(0);
    const mixed = SessionHistory.fromJSON([
      [user("ok"), { role: "tool", tool_call_id: "c1", content: "out" }],
      "rusak",
      [{ role: "assistant", content: "A" }],
    ]);
    expect(mixed.messages().map((m) => m.content)).toEqual(["ok", "out", "A"]);
  });
});

describe("extractFacts (rule-based, no model call)", () => {
  it("captures identity, preference, decision, and explicit remember", () => {
    const facts = extractFacts(
      [
        user("Halo, namaku Rizqi, panggil aku Qi."),
        user("Aku lebih suka model yang murah."),
        user("Keputusan: pakai NanoGPT saja."),
        user("Tolong ingat bahwa aku tidak suka video panjang."),
      ],
      "",
      [],
      [],
      "completed",
    );
    const texts = facts.map((f) => `${f.kind}:${f.text}`);
    expect(
      texts.some((t) => t.startsWith("fakta:") && t.includes("Rizqi")),
    ).toBe(true);
    expect(
      texts.some((t) => t.startsWith("preferensi:") && t.includes("murah")),
    ).toBe(true);
    expect(
      texts.some((t) => t.startsWith("keputusan:") && t.includes("NanoGPT")),
    ).toBe(true);
    expect(texts.some((t) => t.includes("tidak suka video panjang"))).toBe(
      true,
    );
  });

  it("ignores small talk and assistant/tool turns", () => {
    expect(
      extractFacts(
        [
          user("halo"),
          asst("Aku suka kucing."),
          { role: "tool", tool_call_id: "c1", content: "aku suka kopi" },
        ],
        "",
        [],
        [],
        "completed",
      ),
    ).toEqual([]);
  });

  it("records a one-line outcome when files were created", () => {
    const facts = extractFacts(
      [user("buat halaman")],
      "Selesai, halaman kopi sudah jadi.",
      ["index.html"],
      [],
      "completed",
    );
    expect(facts).toHaveLength(1);
    expect(facts[0].kind).toBe("hasil");
    expect(facts[0].text).toContain("index.html");
  });

  it("never records secrets, even when the sentence matches a rule", () => {
    const facts = extractFacts(
      [
        user("Ingat bahwa API key saya sk-abcdefghijklmnopqrstuvwx."),
        user("Tolong ingat password saya adalah rahasia123."),
        user("claim code saya: ABC-123-XYZ."),
      ],
      "",
      [],
      [],
      "completed",
    );
    expect(facts).toEqual([]);
    expect(containsSecret("sk-abcdefghijklmnopqrstuvwx")).toBe(true);
    expect(containsSecret("API_KEY=xyz")).toBe(true);
    expect(containsSecret("Bearer abcdefghijklmnopqrstuv")).toBe(true);
    expect(containsSecret("namaku Rizqi")).toBe(false);
  });
});

describe("memory file format", () => {
  it("round-trips through format/parse and drops secret lines", () => {
    const entries = [
      {
        date: "2026-11-17",
        kind: "preferensi" as const,
        text: "Suka model murah.",
      },
      { date: "2026-11-16", kind: "fakta" as const, text: "Namaku Rizqi." },
    ];
    const text = formatMemory(entries);
    expect(text).toContain("- [2026-11-17] (preferensi) Suka model murah.");
    expect(
      parseMemory(
        `${text}- [2026-11-15] (fakta) key sk-abcdefghijklmnopqrstuvwx\n`,
      ),
    ).toHaveLength(2);
  });

  it("merges without duplicates and keeps the newest entries", () => {
    const existing = [
      { date: "2026-11-10", kind: "fakta" as const, text: "Namaku Rizqi." },
    ];
    const fresh: FreshFact[] = [
      { kind: "fakta", text: "Namaku Rizqi." }, // exact duplicate
      { kind: "fakta", text: "Namaku Rizqi, panggil aku Qi." }, // contains existing
      { kind: "preferensi", text: "Suka model murah." },
    ];
    const merged = mergeFacts(existing, fresh, "2026-11-17");
    expect(merged.map((e) => e.text)).toEqual([
      "Namaku Rizqi, panggil aku Qi.",
      "Suka model murah.",
    ]);
  });
});

describe("buildMemoryContext (prompt injection)", () => {
  it("is newest-first, within budget, and lists recent sessions", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      date: `2026-11-${String(i + 1).padStart(2, "0")}`,
      kind: "fakta" as const,
      text: `Fakta nomor ${i} `.repeat(20),
    }));
    const sessions = Array.from({ length: 7 }, (_, i) => ({
      id: `s_0000000${i}`,
      title: `proyek ${i}`,
      updatedAt: 1000 + i,
    }));
    const ctx = buildMemoryContext(entries, sessions, "s_00000006");
    expect(ctx.length).toBeLessThanOrEqual(MEMORY_INJECT_BUDGET + 500);
    expect(ctx).toContain("Fakta nomor 19"); // newest first
    expect(ctx).toContain("Sesi terakhir:");
    expect(ctx).not.toContain("s_00000006"); // current session excluded
    expect(ctx.match(/proyek \d/g)?.length).toBe(5); // max 5 sessions
  });

  it("returns empty when there is nothing to remember", () => {
    expect(buildMemoryContext([], [], null)).toBe("");
  });
});

describe("selectMemoryEntries (relevance-ranked, Fase 8)", () => {
  const entries = [
    {
      date: "2026-11-10",
      kind: "preferensi" as const,
      text: "Males kalau loading kopi lama.",
    },
    {
      date: "2026-11-17",
      kind: "fakta" as const,
      text: "Suka video pendek.",
    },
    {
      date: "2026-11-16",
      kind: "preferensi" as const,
      text: "Suka kopi panas.",
    },
  ];

  it("ranks a relevant old entry above an irrelevant new one", () => {
    const picked = selectMemoryEntries(entries, "buatkan web kedai kopi");
    expect(picked.map((e) => e.text)).toEqual([
      "Suka kopi panas.", // overlap "kopi", newest of the matches
      "Males kalau loading kopi lama.", // overlap "kopi", older — still beats the new irrelevant entry
      "Suka video pendek.", // no overlap: backfill only
    ]);
  });

  it("ranks by overlap count, not just any match", () => {
    const picked = selectMemoryEntries(entries, "loading lama");
    expect(picked[0].text).toBe("Males kalau loading kopi lama.");
  });

  it("falls back to newest-first with an empty query", () => {
    expect(selectMemoryEntries(entries, "").map((e) => e.date)).toEqual([
      "2026-11-17",
      "2026-11-16",
      "2026-11-10",
    ]);
    expect(
      selectMemoryEntries(entries, "yang dan atau").map((e) => e.date),
    ).toEqual(["2026-11-17", "2026-11-16", "2026-11-10"]);
  });

  it("respects the char budget, keeping the top-ranked entries", () => {
    const picked = selectMemoryEntries(entries, "kopi", 40);
    expect(picked).toHaveLength(1);
    expect(picked[0].text).toBe("Suka kopi panas.");
  });

  it("buildMemoryContext with a query puts the relevant entry first", () => {
    const ctx = buildMemoryContext(entries, [], null, "kedai kopi");
    expect(ctx.indexOf("Suka kopi panas.")).toBeLessThan(
      ctx.indexOf("Suka video pendek."),
    );
    expect(ctx.length).toBeLessThanOrEqual(MEMORY_INJECT_BUDGET + 500);
  });
});

describe("collectImplicitCandidates (rule misses, model bait)", () => {
  it("finds implied preferences the rules do not catch", () => {
    const found = collectImplicitCandidates([
      user("Aku tuh paling males kalau loadingnya lama, bikin bete."),
      user("Biasanya aku ngoding jam 2 pagi."),
      user("Lebih enak kalau tampilannya simpel."),
    ]);
    expect(found).toHaveLength(3);
    expect(found[0]).toContain("paling males");
    expect(found[1]).toContain("Biasanya aku ngoding");
    expect(found[2]).toContain("Lebih enak");
  });

  it("skips sentences the rules already catch, small talk, and other turns", () => {
    expect(
      collectImplicitCandidates([
        user("Aku suka kopi."), // rule: preferensi eksplisit
        user("Namaku Rizqi."), // rule: fakta (also too short)
        user("Halo, apa kabar?"),
        asst("Aku tuh paling males kalau loadingnya lama."),
        { role: "tool", tool_call_id: "c1", content: "biasanya aku begini" },
      ]),
    ).toEqual([]);
  });

  it("never offers a sentence that looks like a secret", () => {
    expect(
      collectImplicitCandidates([
        user("Biasanya aku pakai API key sk-abcdefghijklmnopqrstuvwx."),
      ]),
    ).toEqual([]);
  });
});

describe("extractImplicitFacts (model-assisted, stubbed — no live call)", () => {
  it("parses the model's JSON into preferensi facts", async () => {
    const calls: string[] = [];
    const stub = async (prompt: string) => {
      calls.push(prompt);
      return '[{"kind": "preferensi", "text": "Paling males kalau loading lama."}]';
    };
    const facts = await extractImplicitFacts(
      ["Aku tuh paling males kalau loadingnya lama."],
      stub,
    );
    expect(calls).toHaveLength(1); // max 1 extra call per run
    expect(calls[0]).toContain("Aku tuh paling males kalau loadingnya lama.");
    expect(facts).toEqual([
      { kind: "preferensi", text: "Paling males kalau loading lama." },
    ]);
  });

  it("drops secret and wrong-kind items, keeps the clean ones", () => {
    expect(
      parseImplicitFacts(
        '[{"kind": "preferensi", "text": "Suka kopi panas."}, ' +
          '{"kind": "preferensi", "text": "API key saya sk-abcdefghijklmnopqrstuvwx"}, ' +
          '{"kind": "hasil", "text": "Membuat file x."}, ' +
          '{"kind": "fakta", "text": "Biasanya ngoding malam."}]',
      ),
    ).toEqual([
      { kind: "preferensi", text: "Suka kopi panas." },
      { kind: "fakta", text: "Biasanya ngoding malam." },
    ]);
  });

  it("returns [] on garbage output or a failing call — never throws", async () => {
    expect(
      await extractImplicitFacts(
        ["Biasanya aku begini."],
        async () => "bukan json",
      ),
    ).toEqual([]);
    expect(
      await extractImplicitFacts(["Biasanya aku begini."], async () => ""),
    ).toEqual([]);
    expect(
      await extractImplicitFacts(["Biasanya aku begini."], async () => {
        throw new Error("429 rate limited");
      }),
    ).toEqual([]);
  });

  it("makes no call when there is nothing implicit to extract", async () => {
    let calls = 0;
    await extractImplicitFacts([], async () => {
      calls += 1;
      return "[]";
    });
    expect(calls).toBe(0);
  });
});

describe("extractImplicitPreferences (the gate: flag + :free only)", () => {
  const transcript = [user("Aku tuh paling males kalau loadingnya lama.")];
  const freeModel = "cohere/north-mini-code:free";
  const stubOk = async () =>
    '[{"kind": "preferensi", "text": "Paling males kalau loading lama."}]';

  it("never calls the model when the flag is off", async () => {
    let calls = 0;
    const facts = await extractImplicitPreferences(transcript, {
      enabled: false,
      freeModel,
      callFreeModel: async () => {
        calls += 1;
        return stubOk();
      },
    });
    expect(calls).toBe(0);
    expect(facts).toEqual([]);
  });

  it("never calls when no free provider exists", async () => {
    let calls = 0;
    const facts = await extractImplicitPreferences(transcript, {
      enabled: true,
      freeModel: undefined,
      callFreeModel: async () => {
        calls += 1;
        return stubOk();
      },
    });
    expect(calls).toBe(0);
    expect(facts).toEqual([]);
  });

  it("never calls when the supplied model is paid (Nano/Gemini)", async () => {
    let calls = 0;
    for (const paid of ["z-ai/glm-5.3-flash", "gemini-4-hydrogen"]) {
      const facts = await extractImplicitPreferences(transcript, {
        enabled: true,
        freeModel: paid,
        callFreeModel: async () => {
          calls += 1;
          return stubOk();
        },
      });
      expect(facts).toEqual([]);
    }
    expect(calls).toBe(0);
    expect(isFreeModel("nvidia/nemotron-3.5-lightning:free")).toBe(true);
    expect(isFreeModel("z-ai/glm-5.3-flash")).toBe(false);
    expect(isFreeModel("gemini-4-hydrogen")).toBe(false);
  });

  it("calls exactly once through the free model when the flag is on", async () => {
    let calls = 0;
    const facts = await extractImplicitPreferences(transcript, {
      enabled: true,
      freeModel,
      callFreeModel: async () => {
        calls += 1;
        return stubOk();
      },
    });
    expect(calls).toBe(1);
    expect(facts).toEqual([
      { kind: "preferensi", text: "Paling males kalau loading lama." },
    ]);
  });

  it("makes no call when the run said nothing implicit", async () => {
    let calls = 0;
    const facts = await extractImplicitPreferences([user("halo")], {
      enabled: true,
      freeModel,
      callFreeModel: async () => {
        calls += 1;
        return stubOk();
      },
    });
    expect(calls).toBe(0);
    expect(facts).toEqual([]);
  });
});

describe("implicit preference recalled in the next run (end to end)", () => {
  it("extracts via the stub model, stores, and ranks it into the next run's context", async () => {
    const transcript = [
      user("Aku tuh paling males kalau loadingnya lama banget."),
    ];
    const facts = await extractImplicitPreferences(transcript, {
      enabled: true,
      freeModel: "cohere/north-mini-code:free",
      callFreeModel: async () =>
        '[{"kind": "preferensi", "text": "Paling males kalau loading lama."}]',
    });
    expect(facts).toHaveLength(1);
    // Store like persistence.ts does, then read back like the next run.
    const merged = mergeFacts([], facts, "2026-11-18");
    const stored = parseMemory(formatMemory(merged));
    expect(stored).toHaveLength(1);
    const ctx = buildMemoryContext(stored, [], null, "loadingnya lama banget");
    expect(ctx).toContain("Paling males kalau loading lama.");
  });
});

describe("BIKININ_MEMORY_MODEL_EXTRACT flag", () => {
  it("is off by default and only on/true/1 enable it", () => {
    expect(isMemoryModelExtractEnabled(undefined)).toBe(false);
    expect(isMemoryModelExtractEnabled("off")).toBe(false);
    expect(isMemoryModelExtractEnabled("false")).toBe(false);
    expect(isMemoryModelExtractEnabled("0")).toBe(false);
    expect(isMemoryModelExtractEnabled("on")).toBe(true);
    expect(isMemoryModelExtractEnabled("true")).toBe(true);
    expect(isMemoryModelExtractEnabled("1")).toBe(true);
    expect(isMemoryModelExtractEnabled(" ON ")).toBe(true);
  });
});

describe("persistence on disk", () => {
  async function tmpWs() {
    return mkdtemp(join(tmpdir(), "bikinin-mem-"));
  }

  it("saves and reloads sessions, skipping corrupt and foreign files", async () => {
    const ws = await tmpWs();
    await saveSession(ws, persisted("s_aaaa0001", 1000));
    await saveSession(ws, persisted("s_aaaa0002", 2000));
    // corrupt JSON + a file that is not a session id
    await writeFile(sessionFilePath(ws, "s_aaaa0003"), "{rusak", "utf8");
    await writeFile(
      join(ws, ".bikinin", "sessions", "catatan.txt"),
      "x",
      "utf8",
    );
    const loaded = await loadSessions(ws);
    expect(loaded.map((s) => s.session_id)).toEqual([
      "s_aaaa0002",
      "s_aaaa0001",
    ]);
    expect(loaded[0].history).toEqual([[user("halo")]]);
  });

  it("prunes to the newest sessions", async () => {
    const ws = await tmpWs();
    for (let i = 0; i < 22; i++) {
      await saveSession(
        ws,
        persisted(`s_aaaa${String(i).padStart(4, "0")}`, 1000 + i),
      );
    }
    await pruneSessions(ws, 20);
    const names = await readdir(join(ws, ".bikinin", "sessions"));
    expect(names).toHaveLength(20);
    expect(names).not.toContain("s_aaaa0000.json");
    expect(names).not.toContain("s_aaaa0001.json");
    expect(names).toContain("s_aaaa0021.json");
  });

  it("appends facts to memory.md, dedupes, and writes nothing when empty", async () => {
    const ws = await tmpWs();
    expect(await appendMemoryFacts(ws, [])).toBe(0);
    await expect(readFile(memoryFilePath(ws), "utf8")).rejects.toThrow();
    const added = await appendMemoryFacts(ws, [
      { kind: "fakta", text: "Namaku Rizqi." },
      { kind: "fakta", text: "sk-abcdefghijklmnopqrstuvwx" },
    ]);
    expect(added).toBe(1); // the secret fact is dropped
    const text = await readFile(memoryFilePath(ws), "utf8");
    expect(text).toContain("(fakta) Namaku Rizqi.");
    expect(text).not.toContain("sk-");
    expect(
      await appendMemoryFacts(ws, [{ kind: "fakta", text: "Namaku Rizqi." }]),
    ).toBe(0);
    expect(await readMemoryEntries(ws)).toHaveLength(1);
  });
});
