import type { ChatCompletionMessageParam as Msg } from "openai/resources/chat/completions";
import { describe, expect, it } from "vitest";
import {
  HISTORY_CHAR_BUDGET,
  SessionHistory,
  SUMMARY_THRESHOLD_CHARS,
} from "../src/agent/history.js";
import { extractiveSummary } from "../src/agent/summarize.js";

const toolCall = (id: string, name: string, args: string): Msg => ({
  role: "assistant",
  content: null,
  tool_calls: [
    { id, type: "function", function: { name, arguments: args } },
  ],
});

const contentOf = (m: Msg): string =>
  typeof m.content === "string" ? m.content : "";

describe("extractiveSummary", () => {
  it("keeps the user request, file outcomes, and durable facts", () => {
    const runs: Msg[][] = [
      [
        {
          role: "user",
          content: "namaku Rizqi, tolong ingat aku suka kopi. Buatkan landing page kedai kopi.",
        },
        toolCall(
          "c1",
          "write_file",
          JSON.stringify({ path: "index.html", content: "<h1>Kopi</h1>" }),
        ),
        { role: "tool", tool_call_id: "c1", content: "OK" },
        { role: "assistant", content: "Halaman kopi selesai dibuat." },
      ],
    ];
    const summary = extractiveSummary(runs);
    expect(summary).toContain("landing page kedai kopi");
    expect(summary).toContain("index.html");
    expect(summary).toContain("Rizqi");
    expect(summary).toContain("Halaman kopi selesai");
  });

  it("caps the summary length", () => {
    const runs: Msg[][] = Array.from({ length: 20 }, (_, i) => [
      {
        role: "user",
        content: `permintaan nomor ${i} `.repeat(50),
      } as Msg,
      { role: "assistant", content: "ok" },
    ]);
    expect(extractiveSummary(runs).length).toBeLessThanOrEqual(4100);
  });
});

describe("SessionHistory.summarizeOldest", () => {
  it("does nothing under the threshold", () => {
    const h = new SessionHistory();
    h.add([
      { role: "user", content: "satu" },
      { role: "assistant", content: "A" },
    ]);
    expect(h.summarizeOldest(extractiveSummary)).toBe(0);
    expect(h.runCount).toBe(1);
  });

  it("replaces the oldest runs with a summary and keeps the newest", () => {
    const h = new SessionHistory();
    // Three runs of ~30k chars each: total ~60k, over the 60k summary
    // threshold but under the 80k drop budget, so add() keeps all three
    // and only summarizeOldest trims.
    const chunk = "y".repeat(Math.floor((HISTORY_CHAR_BUDGET * 3) / 8));
    h.add([
      { role: "user", content: "lama: buatkan toko buku" },
      toolCall(
        "c1",
        "write_file",
        JSON.stringify({ path: "toko.html", content: "x" }),
      ),
      { role: "tool", tool_call_id: "c1", content: "OK" },
      { role: "assistant", content: chunk },
    ]);
    h.add([
      { role: "user", content: "tengah" },
      { role: "assistant", content: chunk },
    ]);
    h.add([
      { role: "user", content: "baru" },
      { role: "assistant", content: "B" },
    ]);
    expect(h.charCount).toBeGreaterThan(SUMMARY_THRESHOLD_CHARS);
    const replaced = h.summarizeOldest(extractiveSummary);
    expect(replaced).toBeGreaterThan(0);
    const msgs = h.messages();
    // The newest run survives verbatim…
    expect(msgs.map(contentOf)).toContain("baru");
    // …the oldest run survives only as a summary mentioning what mattered.
    const summary = msgs.find((m) =>
      contentOf(m).includes("Ringkasan obrolan sebelumnya"),
    );
    expect(summary).toBeDefined();
    expect(contentOf(summary!)).toContain("toko buku");
    expect(contentOf(summary!)).toContain("toko.html");
    // The history is back under the threshold.
    expect(h.charCount).toBeLessThanOrEqual(SUMMARY_THRESHOLD_CHARS + 5000);
  });
});
