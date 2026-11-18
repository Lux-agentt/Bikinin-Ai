// Tests for the Fase 7 eval benchmark: deterministic behaviour proxies,
// task checkers, and the runner end to end with the dummy model.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmitter, type AgentEvent } from "../src/events.js";
import {
  admitsMistakeAfterFailure,
  askedBeforeMutating,
  summaryStatesReason,
  type CheckContext,
} from "../src/eval/checks.js";
import { createDummyLlm } from "../src/eval/dummy.js";
import { runEvalSuite, runEvalTask } from "../src/eval/runner.js";
import { getTask, planFirstScript, TASKS } from "../src/eval/tasks.js";
import type { LlmClient } from "../src/llm/client.js";
import { tempWorkspace } from "./helpers.js";

function ctxWith(
  events: AgentEvent[],
  summary: string,
  overrides: Partial<CheckContext> = {},
): CheckContext {
  return {
    workspace: "",
    events,
    summary,
    status: "completed",
    filesCreated: [],
    filesChanged: [],
    ...overrides,
  };
}

function eventsFrom(runId: string, build: (emit: ReturnType<typeof createEmitter>) => void): AgentEvent[] {
  const events: AgentEvent[] = [];
  const emit = createEmitter(runId, (e) => events.push(e));
  build(emit);
  return events;
}

describe("behaviour proxies", () => {
  it("askedBeforeMutating: question before write passes", () => {
    const events = eventsFrom("r1", (emit) => {
      emit("run_started", {
        session_id: "s",
        model: "m",
        effort: "sedang",
        user_message: "x",
        limits: { max_steps: 10, max_cost_usd: 1 },
      });
      emit("text_delta", { text: "Mau dibuatkan apa?" });
      emit("tool_call_started", {
        call_id: "c1",
        step: 1,
        tool: "write_file",
        label: "write_file a.txt",
        args: { path: "a.txt" },
      });
    });
    expect(askedBeforeMutating(ctxWith(events, ""))).toBe(true);
  });

  it("askedBeforeMutating: write before any question fails", () => {
    const events = eventsFrom("r2", (emit) => {
      emit("run_started", {
        session_id: "s",
        model: "m",
        effort: "sedang",
        user_message: "x",
        limits: { max_steps: 10, max_cost_usd: 1 },
      });
      emit("tool_call_started", {
        call_id: "c1",
        step: 1,
        tool: "edit_file",
        label: "edit_file a.js",
        args: { path: "a.js" },
      });
      emit("text_delta", { text: "Maksudnya file yang mana?" });
    });
    expect(askedBeforeMutating(ctxWith(events, ""))).toBe(false);
  });

  it("askedBeforeMutating: asking with no mutation passes", () => {
    expect(
      askedBeforeMutating(ctxWith([], "Mau dibuatkan apa?")),
    ).toBe(true);
    expect(askedBeforeMutating(ctxWith([], "Selesai."))).toBe(false);
  });

  it("summaryStatesReason detects Indonesian reason markers", () => {
    expect(summaryStatesReason("Selesai karena tugasnya sederhana.")).toBe(true);
    expect(summaryStatesReason("Saya memakai HTML polos supaya cepat dibuka.")).toBe(true);
    expect(summaryStatesReason("Selesai.")).toBe(false);
  });

  it("admitsMistakeAfterFailure needs a failure and an apology", () => {
    const failed = eventsFrom("r3", (emit) => {
      emit("run_started", {
        session_id: "s",
        model: "m",
        effort: "sedang",
        user_message: "x",
        limits: { max_steps: 10, max_cost_usd: 1 },
      });
      emit("tool_call_started", {
        call_id: "c1",
        step: 1,
        tool: "read_file",
        label: "read_file x.txt",
        args: { path: "x.txt" },
      });
      emit("tool_call_finished", {
        call_id: "c1",
        ok: false,
        summary: "gagal",
        truncated: false,
        duration_ms: 5,
      });
    });
    expect(
      admitsMistakeAfterFailure(ctxWith(failed, "Maaf, saya salah baca.")),
    ).toBe(true);
    expect(
      admitsMistakeAfterFailure(ctxWith(failed, "Selesai.")),
    ).toBe(false);
    expect(admitsMistakeAfterFailure(ctxWith([], "Maaf, saya salah."))).toBe(
      false,
    );
  });
});

describe("task registry", () => {
  it("has 10-20 tasks with unique ids and a check each", () => {
    expect(TASKS.length).toBeGreaterThanOrEqual(10);
    expect(TASKS.length).toBeLessThanOrEqual(20);
    const ids = TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TASKS) {
      expect(typeof t.check).toBe("function");
      expect(t.prompt.length).toBeGreaterThan(0);
      if (!t.requiresNetwork) expect(t.dummyScript).toBeDefined();
    }
  });

  it("covers all six categories including behaviour tasks", () => {
    const cats = new Set(TASKS.map((t) => t.category));
    for (const c of ["bugfix", "feature", "research", "fileops", "edge", "behavior"])
      expect(cats.has(c as never)).toBe(true);
    expect(TASKS.filter((t) => t.category === "behavior").length).toBeGreaterThanOrEqual(3);
  });

  it("never claims to beat humans", () => {
    const blob = JSON.stringify(TASKS);
    expect(blob).not.toMatch(/mengalahkan manusia|beats humans|beat humans/i);
  });

  it("has at least one network task that dummy mode must skip", () => {
    expect(TASKS.some((t) => t.requiresNetwork)).toBe(true);
  });
});

describe("runner with dummy model", () => {
  async function runTask(id: string) {
    const task = getTask(id);
    if (!task) throw new Error(`no task ${id}`);
    const workspaceRoot = await tempWorkspace();
    return runEvalTask(task, {
      workspaceRoot,
      systemPrompt: "sys",
      llm: createDummyLlm(planFirstScript(task)),
      modelLabel: "dummy",
      maxSteps: 10,
      maxCostUsd: 1,
      prices: { inPerM: 0, outPerM: 0 },
      runDir: join(workspaceRoot, "runs"),
    });
  }

  it("bugfix-off-by-one passes and the file really runs to 15", async () => {
    const r = await runTask("bugfix-off-by-one");
    expect(r.status).toBe("pass");
    expect(r.steps).toBeGreaterThan(0);
    expect(r.costUsd).toBe(0);
  });

  it("behavior-vague passes (asks, never mutates)", async () => {
    const r = await runTask("behavior-vague");
    expect(r.status).toBe("pass");
    expect(r.steps).toBe(0);
  });

  it("behavior-ambiguous FAILS by design (guesses without asking)", async () => {
    const r = await runTask("behavior-ambiguous");
    expect(r.status).toBe("fail");
    expect(r.details).toMatch(/menebak/);
  });

  it("behavior-remember-context passes using prior conversation", async () => {
    const r = await runTask("behavior-remember-context");
    expect(r.status).toBe("pass");
  });

  it("edge-missing-file passes by honestly reporting the miss", async () => {
    const r = await runTask("edge-missing-file");
    expect(r.status).toBe("pass");
  });

  it("dummy llm falls back honestly when its script runs out", async () => {
    const llm = createDummyLlm([]);
    const r = await llm.chat({
      model: "dummy",
      messages: [],
      tools: [],
    });
    expect(r.toolCalls).toEqual([]);
    expect(r.text).toMatch(/berhenti/);
  });
});

describe("task checkers on real files", () => {
  it("fileops-copy check fails when the copy differs", async () => {
    const task = getTask("fileops-copy");
    if (!task) throw new Error("no task");
    const ws = await tempWorkspace();
    await writeFile(join(ws, "a.txt"), "Isi penting: rapat jam 10.\n", "utf8");
    await mkdir(join(ws, "arsip"), { recursive: true });
    await writeFile(join(ws, "arsip", "a.txt"), "isi lain\n", "utf8");
    const out = await task.check(ctxWith([], "", { workspace: ws }));
    expect(out.passed).toBe(false);
  });

  it("edge-unicode check passes only on an exact copy", async () => {
    const task = getTask("edge-unicode");
    if (!task) throw new Error("no task");
    const ws = await tempWorkspace();
    const content = `Dia berkata: "Halo 👋, kopi susu 1!" — selesai.\n`;
    await writeFile(join(ws, "kutip.txt"), content, "utf8");
    await writeFile(join(ws, "salinan.txt"), content, "utf8");
    const out = await task.check(ctxWith([], "", { workspace: ws }));
    expect(out.passed).toBe(true);
    expect(await readFile(join(ws, "salinan.txt"), "utf8")).toBe(content);
  });
});

describe("suite log + rate-limit retry", () => {
  it("two runs on the same day write two different log files", async () => {
    const ws = await tempWorkspace();
    const outDir = join(ws, "logs");
    const opts = {
      workspaceRoot: ws,
      systemPrompt: "sys",
      llmFor: () => createDummyLlm([]),
      modelLabel: "dummy",
      mode: "dummy" as const,
      only: ["bugfix-off-by-one"],
      outDir,
    };
    const first = await runEvalSuite(opts);
    const second = await runEvalSuite(opts);
    expect(first.logPath).not.toBe(second.logPath);
    expect(await readFile(first.logPath, "utf8")).toContain("bugfix-off-by-one");
    expect(await readFile(second.logPath, "utf8")).toContain("bugfix-off-by-one");
  });

  it("rate-limited task is retried once and passes", async () => {
    const ws = await tempWorkspace();
    const task = getTask("bugfix-off-by-one");
    if (!task) throw new Error("no task bugfix-off-by-one");
    let calls = 0;
    const llmFor = (): LlmClient => {
      calls += 1;
      if (calls === 1) {
        return {
          chat: async () => {
            throw new Error("Kena rate limit penyedia (429)");
          },
        };
      }
      return createDummyLlm(planFirstScript(task));
    };
    const { report } = await runEvalSuite({
      workspaceRoot: ws,
      systemPrompt: "sys",
      llmFor,
      modelLabel: "live-test",
      mode: "live",
      only: ["bugfix-off-by-one"],
      retryDelayMs: 0,
    });
    expect(calls).toBe(2);
    expect(report.results[0]?.status).toBe("pass");
  });

  it("research-web prompt names web_search explicitly", () => {
    const task = getTask("research-web");
    if (!task) throw new Error("no task research-web");
    expect(task.prompt).toContain("web_search");
  });
});
