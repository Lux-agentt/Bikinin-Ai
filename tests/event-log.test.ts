import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentEvent, createEmitter } from "../src/events.js";
import {
  createEventLog,
  readSessionEvents,
  redactSecrets,
  scrubEvent,
  sessionLogPath,
} from "../src/server/event-log.js";
import { tempWorkspace } from "./helpers.js";

function buildEvents(): AgentEvent[] {
  const events: AgentEvent[] = [];
  const emit = createEmitter("run_test", (e) => events.push(e));
  emit("run_started", {
    session_id: "s_12345678",
    model: "test-model",
    effort: "sedang",
    user_message: "buat halaman kopi",
    limits: { max_steps: 10, max_cost_usd: 1 },
  });
  emit("text_delta", { text: "Siap, " });
  emit("text_delta", { text: "dibuatkan." });
  emit("run_finished", {
    status: "completed",
    summary: "Selesai.",
    totals: {
      steps: 1,
      input_tokens: 10,
      output_tokens: 5,
      cached_tokens: 0,
      cost_usd: 0.001,
    },
    duration_ms: 10,
    resumable: false,
  });
  return events;
}

describe("redactSecrets", () => {
  it("redacts key-shaped values but keeps ordinary text", () => {
    expect(redactSecrets("kunci sk-abcdefghijklmnop1234 disini")).toContain(
      "[rahasia]",
    );
    expect(redactSecrets("kunci sk-abcdefghijklmnop1234 disini")).not.toContain(
      "sk-",
    );
    expect(redactSecrets("Bearer abcdefghijklmnopqr")).toBe(
      "Bearer [rahasia]",
    );
    expect(redactSecrets("kopi panas enak")).toBe("kopi panas enak");
    expect(
      redactSecrets("LLM_API_KEY=sk-abcdefghijklmnop1234"),
    ).toContain("LLM_API_KEY=[rahasia]");
  });
});

describe("event log (JSONL)", () => {
  it("round-trips events in order, valid NDJSON per line", async () => {
    const workspace = await tempWorkspace();
    const events = buildEvents();
    const log = createEventLog(workspace, "s_12345678");
    for (const e of events) log.append(e);
    await log.flush();

    const raw = await readFile(
      sessionLogPath(workspace, "s_12345678"),
      "utf8",
    );
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(events.length);
    for (const line of lines) {
      expect(AgentEvent.safeParse(JSON.parse(line)).success).toBe(true);
    }
    const read = await readSessionEvents(workspace, "s_12345678");
    expect(read.map((e) => e.type)).toEqual(events.map((e) => e.type));
    expect(read[0].type).toBe("run_started");
    expect(read.at(-1)?.type).toBe("run_finished");
  });

  it("scrubs secrets from the file but keeps the structure", async () => {
    const workspace = await tempWorkspace();
    const events: AgentEvent[] = [];
    const emit = createEmitter("run_test", (e) => events.push(e));
    emit("text_delta", { text: "kunci saya sk-abcdefghijklmnop1234 ya" });
    emit("run_finished", {
      status: "completed",
      summary: "ok",
      totals: {
        steps: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        cost_usd: 0,
      },
      duration_ms: 0,
      resumable: false,
    });
    const log = createEventLog(workspace, "s_12345678");
    for (const e of events) log.append(e);
    await log.flush();

    const raw = await readFile(
      sessionLogPath(workspace, "s_12345678"),
      "utf8",
    );
    expect(raw).not.toContain("sk-abcdefghijklmnop1234");
    expect(raw).toContain("[rahasia]");
    // …and the scrubbed file still parses and replays.
    const read = await readSessionEvents(workspace, "s_12345678");
    expect(read).toHaveLength(2);
    expect(scrubEvent(events[0]).type).toBe("text_delta");
  });

  it("skips corrupt lines and returns [] for a missing log", async () => {
    const workspace = await tempWorkspace();
    expect(await readSessionEvents(workspace, "s_12345678")).toEqual([]);
    await mkdir(join(workspace, ".bikinin", "sessions"), { recursive: true });
    const good = buildEvents()[0];
    await writeFile(
      sessionLogPath(workspace, "s_12345678"),
      `${JSON.stringify(good)}\n{bukan json\n${JSON.stringify(good)}\n`,
      "utf8",
    );
    const read = await readSessionEvents(workspace, "s_12345678");
    expect(read).toHaveLength(2);
  });

  it("flush resolves only after appends reach disk", async () => {
    const workspace = await tempWorkspace();
    const log = createEventLog(workspace, "s_12345678");
    log.append(buildEvents()[0]);
    await log.flush();
    const raw = await readFile(
      sessionLogPath(workspace, "s_12345678"),
      "utf8",
    );
    expect(raw).toContain("run_started");
  });
});
