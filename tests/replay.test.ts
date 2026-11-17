import { describe, expect, it } from "vitest";
import type { ChatCompletionMessageParam as Msg } from "openai/resources/chat/completions";
import { createEmitter, type AgentEvent } from "../src/events.js";
import { rebuildHistory } from "../src/agent/replay.js";

const totals = {
  steps: 1,
  input_tokens: 10,
  output_tokens: 5,
  cached_tokens: 0,
  cost_usd: 0.001,
};

/** Builds one run's events with a fresh emitter (seq restarts per run, like the real loop). */
function runEvents(
  runId: string,
  userMessage: string,
  tool: { name: string; args: Record<string, unknown>; output: string } | null,
  finalText: string,
): AgentEvent[] {
  const events: AgentEvent[] = [];
  const emit = createEmitter(runId, (e) => events.push(e));
  emit("run_started", {
    session_id: "s_12345678",
    model: "test-model",
    effort: "sedang",
    user_message: userMessage,
    limits: { max_steps: 10, max_cost_usd: 1 },
  });
  if (tool) {
    emit("tool_call_started", {
      call_id: "c1",
      step: 1,
      tool: tool.name as "write_file",
      label: `${tool.name} x`,
      args: tool.args,
    });
    emit("tool_call_finished", {
      call_id: "c1",
      ok: true,
      summary: "ditulis",
      output_preview: tool.output,
      truncated: false,
      duration_ms: 5,
    });
  }
  emit("text_delta", { text: finalText });
  emit("run_finished", {
    status: "completed",
    summary: finalText,
    totals,
    duration_ms: 10,
    resumable: false,
  });
  return events;
}

const contentOf = (m: Msg): string =>
  typeof m.content === "string" ? m.content : "";

describe("rebuildHistory", () => {
  it("rebuilds user turns, tool calls, and streamed text across runs", () => {
    const events = [
      ...runEvents("run_a", "buat halaman kopi", {
        name: "write_file",
        args: { path: "index.html", content: "<h1>Kopi</h1>" },
        output: "OK: index.html ditulis",
      }, "Selesai, halaman kopi jadi."),
      ...runEvents("run_b", "tambah judul", null, "Judul ditambahkan."),
    ];
    const history = rebuildHistory(events);
    expect(history.runCount).toBe(2);
    const msgs = history.messages();
    const users = msgs.filter((m) => m.role === "user").map(contentOf);
    expect(users).toEqual(["buat halaman kopi", "tambah judul"]);
    expect(msgs.map(contentOf)).toContain("Selesai, halaman kopi jadi.");
    expect(msgs.map(contentOf)).toContain("Judul ditambahkan.");
    // tool call + result survive as a pair
    const toolMsg = msgs.find(
      (m) => m.role === "tool" && m.tool_call_id === "c1",
    );
    expect(contentOf(toolMsg!)).toContain("index.html");
    const assistantCall = msgs.find(
      (m) =>
        m.role === "assistant" &&
        m.tool_calls?.some(
          (c) => c.type === "function" && c.function.name === "write_file",
        ),
    );
    expect(assistantCall).toBeDefined();
  });

  it("drops a tool call whose result never arrived", () => {
    const events: AgentEvent[] = [];
    const emit = createEmitter("run_a", (e) => events.push(e));
    emit("run_started", {
      session_id: "s_12345678",
      model: "test-model",
      effort: "sedang",
      user_message: "coba",
      limits: { max_steps: 10, max_cost_usd: 1 },
    });
    emit("tool_call_started", {
      call_id: "c1",
      step: 1,
      tool: "write_file",
      label: "write_file x",
      args: { path: "a.html" },
    });
    emit("run_finished", {
      status: "error",
      summary: "gagal",
      totals,
      duration_ms: 5,
      resumable: false,
    });
    const msgs = rebuildHistory(events).messages();
    expect(msgs.some((m) => m.role === "assistant" && m.tool_calls)).toBe(
      false,
    );
    expect(msgs.filter((m) => m.role === "user").map(contentOf)).toEqual([
      "coba",
    ]);
  });

  it("returns empty history for no events", () => {
    const history = rebuildHistory([]);
    expect(history.runCount).toBe(0);
    expect(history.messages()).toEqual([]);
  });

  it("ignores non-transcript events (approvals, usage, errors)", () => {
    const events: AgentEvent[] = [];
    const emit = createEmitter("run_a", (e) => events.push(e));
    emit("run_started", {
      session_id: "s_12345678",
      model: "test-model",
      effort: "sedang",
      user_message: "hai",
      limits: { max_steps: 10, max_cost_usd: 1 },
    });
    emit("approval_requested", {
      approval_id: "a1",
      call_id: "c1",
      tool: "run_command",
      command: "npm install",
      reason: "di luar allowlist",
      risk: "medium",
    });
    emit("usage", {
      step: 0,
      input_tokens: 5,
      output_tokens: 5,
      cached_tokens: 0,
      cost_usd: 0.001,
      totals,
    });
    emit("error", {
      code: "provider_error",
      message: "timeout",
      retryable: true,
    });
    emit("run_finished", {
      status: "completed",
      summary: "Halo.",
      totals,
      duration_ms: 5,
      resumable: false,
    });
    const msgs = rebuildHistory(events).messages();
    expect(msgs.map(contentOf)).toEqual(["hai", "Halo."]);
  });
});
