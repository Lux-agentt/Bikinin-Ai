import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent, type AgentDeps } from "../src/agent/loop.js";
import {
  createEmitter,
  type AgentEvent,
  type EventType,
} from "../src/events.js";
import type {
  ChatMessage,
  ChatResult,
  LlmClient,
  ToolCallReq,
} from "../src/llm/client.js";
import { tempWorkspace } from "./helpers.js";

const usage = { input_tokens: 100, output_tokens: 20, cached_tokens: 0 };

function call(id: string, name: string, args: unknown): ToolCallReq {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}
const withCalls = (...toolCalls: ToolCallReq[]): ChatResult => ({
  text: "",
  toolCalls,
  usage,
});
const finalText = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  usage,
});

function scripted(responses: ChatResult[]): LlmClient {
  let i = 0;
  return {
    async chat(p) {
      const r = responses[i++];
      if (!r) throw new Error("skrip habis");
      if (r.text) p.onText?.(r.text);
      return r;
    },
  };
}

function ofType<T extends EventType>(events: AgentEvent[], type: T) {
  return events.filter(
    (e): e is Extract<AgentEvent, { type: T }> => e.type === type,
  );
}

async function run(
  responses: ChatResult[],
  overrides: Partial<AgentDeps> = {},
) {
  const workspace = await tempWorkspace();
  const events: AgentEvent[] = [];
  const emit = createEmitter("run_test", (e) => events.push(e));
  const deps: AgentDeps = {
    llm: scripted(responses),
    model: "test-model",
    systemPrompt: "sys",
    message: "tes",
    sessionId: "s_test",
    workspace,
    limits: { maxSteps: 10, maxCostUsd: 1 },
    prices: { inPerM: 1, outPerM: 2 },
    emit,
    approve: async () => false,
    ...overrides,
  };
  const result = await runAgent(deps);
  return { workspace, events, result };
}

const types = (events: AgentEvent[]) => events.map((e) => e.type);

function expectWellFormed(events: AgentEvent[]) {
  expect(types(events)[0]).toBe("run_started");
  expect(types(events).at(-1)).toBe("run_finished");
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
  const started = ofType(events, "tool_call_started")
    .map((e) => e.call_id)
    .sort();
  const finished = ofType(events, "tool_call_finished")
    .map((e) => e.call_id)
    .sort();
  expect(finished).toEqual(started);
  expect(JSON.stringify(events)).not.toMatch(/\/home\/|LLM_API_KEY/);
}

describe("agent loop event contract", () => {
  // Fase 5: plan-first — the loop nudges the model to call update_plan
  // before any other tool, so scripted models below start with a plan.
  const plan = (id: string) =>
    call(id, "update_plan", {
      items: [{ text: "Kerjakan tugas", status: "doing" }],
    });

  it("writes a file, emits valid ordered events, and completes", async () => {
    const { workspace, events, result } = await run([
      withCalls(plan("t0")),
      withCalls(
        call("t1", "write_file", {
          path: "index.html",
          content: "<h1>Kopi</h1>",
        }),
      ),
      finalText("Selesai."),
    ]);
    expect(result.status).toBe("completed");
    expect(result.filesCreated).toEqual(["index.html"]);
    expect(await readFile(join(workspace, "index.html"), "utf8")).toBe(
      "<h1>Kopi</h1>",
    );
    expect(ofType(events, "file_changed")[0].path).toBe("index.html");
    expectWellFormed(events);
  });

  it("keeps the file content out of emitted arguments", async () => {
    const { events } = await run([
      withCalls(plan("t0")),
      withCalls(
        call("t1", "write_file", { path: "a.txt", content: "RAHASIA_ISI" }),
      ),
      finalText("ok"),
    ]);
    expect(JSON.stringify(ofType(events, "tool_call_started"))).not.toContain(
      "RAHASIA_ISI",
    );
  });

  it("places approval between tool start and finish, and denies by default", async () => {
    const { workspace, events, result } = await run([
      withCalls(plan("t0")),
      withCalls(call("t1", "run_command", { command: "npm install" })),
      finalText("ok"),
    ]);
    expect(result.status).toBe("completed");
    const order = types(events);
    const req = order.indexOf("approval_requested");
    // The plan call finishes first; the approval must sit between the
    // run_command's own start and finish (the last of each).
    expect(req).toBeGreaterThan(order.lastIndexOf("tool_call_started"));
    expect(req).toBeLessThan(order.lastIndexOf("tool_call_finished"));
    expect(ofType(events, "approval_resolved")[0].decision).toBe("deny");
    // [0] is the plan call's finish (ok); the denied run_command is the last finish.
    const finished = ofType(events, "tool_call_finished");
    expect(finished[finished.length - 1].ok).toBe(false);
    expectWellFormed(events);
    await expect(
      readFile(join(workspace, "node_modules"), "utf8"),
    ).rejects.toThrow();
  });

  it("blocks destructive commands without asking", async () => {
    const { events } = await run([
      withCalls(plan("t0")),
      withCalls(call("t1", "run_command", { command: "sudo ls" })),
      finalText("ok"),
    ]);
    expect(ofType(events, "approval_requested")).toHaveLength(0);
    expect(ofType(events, "error")[0].code).toBe("command_blocked");
    expectWellFormed(events);
  });

  it("returns invalid tool arguments to the model instead of crashing", async () => {
    const { events, result } = await run([
      withCalls(plan("t0")),
      withCalls(call("t1", "write_file", { path: "a.txt" })),
      finalText("maaf, saya perbaiki"),
    ]);
    expect(result.status).toBe("completed");
    // The plan call finishes first; the invalid-args finish is the last one.
    expect(ofType(events, "tool_call_finished").at(-1)?.ok).toBe(false);
    expectWellFormed(events);
  });

  it("stops with budget_exceeded before running tools that would pass the step limit", async () => {
    const { events, result } = await run(
      [
        withCalls(
          call("t1", "list_dir", { path: "." }),
          call("t2", "list_dir", { path: "." }),
        ),
      ],
      { limits: { maxSteps: 1, maxCostUsd: 1 } },
    );
    expect(result.status).toBe("budget_exceeded");
    const finished = ofType(events, "run_finished")[0];
    expect(finished.resumable).toBe(true);
    expect(ofType(events, "tool_call_started")).toHaveLength(0);
    expectWellFormed(events);
  });

  it("ends with status error and a final run_finished when the provider fails", async () => {
    const { events, result } = await run([]);
    expect(result.status).toBe("error");
    expect(ofType(events, "error")[0].code).toBe("internal");
    expectWellFormed(events);
  });

  it("still blocks a dangerous command when approve() always says yes (--yolo)", async () => {
    // --yolo only auto-approves "confirm" verdicts; "block" is enforced
    // before approve() is ever consulted.
    const { events, result } = await run(
      [
        withCalls(plan("t0")),
        withCalls(call("t1", "run_command", { command: "rm -rf /" })),
        finalText("selesai"),
      ],
      { approve: async () => true },
    );
    expect(result.status).toBe("completed");
    expect(ofType(events, "error")[0].code).toBe("command_blocked");
    // The plan call finishes first; the blocked call's finish is the last one.
    expect(
      ofType(events, "tool_call_finished").at(-1)?.summary,
    ).toContain("diblokir");
    expectWellFormed(events);
  });

  it("assistant message with tool_calls carries empty-string content", async () => {
    // Gemini's OpenAI-compatible endpoint rejects a tool-call message
    // with null content; empty string is accepted everywhere.
    const workspace = await tempWorkspace();
    await writeFile(join(workspace, "a.txt"), "hello\n", "utf8");
    const seen: ChatMessage[][] = [];
    let n = 0;
    const llm: LlmClient = {
      async chat(p) {
        seen.push(p.messages);
        n += 1;
        if (n === 1) return withCalls(plan("t0"));
        if (n === 2)
          return withCalls(call("t1", "read_file", { path: "a.txt" }));
        return finalText("Selesai.");
      },
    };
    const events: AgentEvent[] = [];
    const emit = createEmitter("run_test", (e) => events.push(e));
    const result = await runAgent({
      llm,
      model: "test-model",
      systemPrompt: "sys",
      message: "baca a.txt",
      sessionId: "s_test",
      workspace,
      limits: { maxSteps: 10, maxCostUsd: 1 },
      prices: { inPerM: 1, outPerM: 2 },
      emit,
      approve: async () => false,
    });
    expect(result.status).toBe("completed");
    const second = seen[1] ?? [];
    const asst = second.find(
      (m) => m.role === "assistant" && "tool_calls" in m && m.tool_calls,
    );
    expect(asst).toBeDefined();
    expect((asst as { content: unknown }).content).toBe("");
  });

  it("echoes a Gemini thought signature back on the tool-call message", async () => {
    const workspace = await tempWorkspace();
    await writeFile(join(workspace, "a.txt"), "hello\n", "utf8");
    const seen: ChatMessage[][] = [];
    let n = 0;
    const signedRead: ToolCallReq = {
      id: "t1",
      type: "function",
      function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) },
      thoughtSignature: "sig-xyz",
    };
    const llm: LlmClient = {
      async chat(p) {
        seen.push(p.messages);
        n += 1;
        if (n === 1) return withCalls(plan("t0"));
        if (n === 2) return { text: "", toolCalls: [signedRead], usage };
        return finalText("Selesai.");
      },
    };
    const events: AgentEvent[] = [];
    const emit = createEmitter("run_test", (e) => events.push(e));
    const result = await runAgent({
      llm,
      model: "test-model",
      systemPrompt: "sys",
      message: "baca a.txt",
      sessionId: "s_test",
      workspace,
      limits: { maxSteps: 10, maxCostUsd: 1 },
      prices: { inPerM: 1, outPerM: 2 },
      emit,
      approve: async () => false,
    });
    expect(result.status).toBe("completed");
    // Request 3 carries the signed read_file call echoed back (the plan
    // call echoed earlier has no signature, so match by tool name).
    const third = seen[2] ?? [];
    const asst = third.find(
      (m) =>
        m.role === "assistant" &&
        "tool_calls" in m &&
        m.tool_calls?.some(
          (tc) =>
            tc.type === "function" && tc.function.name === "read_file",
        ),
    );
    expect(asst).toBeDefined();
    const toolResult = third.find(
      (m) => m.role === "tool" && m.tool_call_id === "t1",
    );
    expect(toolResult).toMatchObject({
      role: "tool",
      tool_call_id: "t1",
      name: "read_file",
    });
    const tc = (
      asst as {
        tool_calls?: Array<Record<string, unknown>>;
      }
    ).tool_calls?.find(
      (t) =>
        (t as { function?: { name?: string } }).function?.name ===
        "read_file",
    ) as
      | { extra_content?: { google?: { thought_signature?: string } } }
      | undefined;
    expect(tc?.extra_content?.google?.thought_signature).toBe("sig-xyz");
  });

  it("echoes a text turn's thought signature on the assistant message", async () => {
    // A turn that mixes text and a tool call carries its signature on the
    // message itself; without it Gemini 400s the next request (edge
    // tasks, live eval 2026-11-18).
    const workspace = await tempWorkspace();
    await writeFile(join(workspace, "a.txt"), "hello\n", "utf8");
    const seen: ChatMessage[][] = [];
    let n = 0;
    const llm: LlmClient = {
      async chat(p) {
        seen.push(p.messages);
        n += 1;
        if (n === 1) return withCalls(plan("t0"));
        if (n === 2)
          return {
            text: "Saya cek dulu isinya.",
            toolCalls: [
              call("t1", "read_file", { path: "a.txt" }),
            ],
            usage,
            messageThoughtSignature: "sig-teks",
          };
        return finalText("Selesai.");
      },
    };
    const events: AgentEvent[] = [];
    const emit = createEmitter("run_test", (e) => events.push(e));
    const result = await runAgent({
      llm,
      model: "test-model",
      systemPrompt: "sys",
      message: "baca a.txt",
      sessionId: "s_test",
      workspace,
      limits: { maxSteps: 10, maxCostUsd: 1 },
      prices: { inPerM: 1, outPerM: 2 },
      emit,
      approve: async () => false,
    });
    expect(result.status).toBe("completed");
    const third = seen[2] ?? [];
    const asst = third.find(
      (m) =>
        m.role === "assistant" &&
        "tool_calls" in m &&
        m.tool_calls?.some(
          (tc) =>
            tc.type === "function" && tc.function.name === "read_file",
        ),
    );
    expect(asst).toBeDefined();
    expect((asst as { content: unknown }).content).toBe(
      "Saya cek dulu isinya.",
    );
    const msgSig = (
      asst as {
        extra_content?: { google?: { thought_signature?: string } };
      }
    ).extra_content?.google?.thought_signature;
    expect(msgSig).toBe("sig-teks");
  });
});

describe("stop (AbortSignal)", () => {
  it("run yang dibatalkan selagi tool jalan tidak menjalankan tool dan selesai stopped", async () => {
    const ctrl = new AbortController();
    const llm: LlmClient = {
      async chat() {
        // Pengguna menekan Stop selagi model menjawab.
        ctrl.abort();
        return withCalls(
          call("t1", "write_file", { path: "a.txt", content: "x" }),
        );
      },
    };
    const { workspace, events, result } = await run([], {
      llm,
      signal: ctrl.signal,
    });
    expect(result.status).toBe("stopped");
    expect(ofType(events, "tool_call_started")).toEqual([]);
    await expect(readFile(join(workspace, "a.txt"), "utf8")).rejects.toThrow();
    expectWellFormed(events);
  });
});
