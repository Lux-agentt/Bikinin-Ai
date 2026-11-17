// Eval runner (Fase 7): runs each task as a black box through runAgent in
// its own workspace, scores it with the task's automatic check, and writes
// a JSON log. Logs live OUTSIDE the repo (workspace/.bikinin/evals/);
// task definitions may live in the repo, logs never do.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runAgent, type AgentResult } from "../agent/loop.js";
import { createEmitter, type AgentEvent } from "../events.js";
import type { LlmClient } from "../llm/client.js";
import { createDummyLlm } from "./dummy.js";
import { planFirstScript, TASKS, type EvalTask } from "./tasks.js";

export interface EvalTaskResult {
  id: string;
  category: string;
  title: string;
  status: "pass" | "fail" | "skip";
  details: string;
  manual?: string;
  agentStatus: string;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}

export interface EvalReport {
  version: 1;
  mode: "dummy" | "live";
  model: string;
  startedAt: string;
  finishedAt: string;
  totals: {
    tasks: number;
    passed: number;
    failed: number;
    skipped: number;
    /** Pass rate over attempted (non-skipped) tasks, 0-100. */
    scorePct: number;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
  results: EvalTaskResult[];
}

export interface RunEvalOptions {
  /** Workspace root for per-task dirs and (by default) the log dir. */
  workspaceRoot: string;
  systemPrompt: string;
  /** Factory: fresh LLM client per task. */
  llmFor: (task: EvalTask) => LlmClient;
  modelLabel: string;
  mode: "dummy" | "live";
  maxSteps?: number;
  maxCostUsd?: number;
  prices?: { inPerM: number; outPerM: number };
  /** Where to write the JSON log. Defaults to <workspaceRoot>/.bikinin/evals. */
  outDir?: string;
  /** Subset of task ids to run; default = all. */
  only?: string[];
  /** Skip network tasks (dummy mode). Default true when mode === "dummy". */
  skipNetwork?: boolean;
}

const slug = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 40);

export async function runEvalTask(
  task: EvalTask,
  opts: {
    workspaceRoot: string;
    systemPrompt: string;
    llm: LlmClient;
    modelLabel: string;
    maxSteps: number;
    maxCostUsd: number;
    prices: { inPerM: number; outPerM: number };
    runDir: string;
  },
): Promise<EvalTaskResult> {
  const dir = resolve(opts.runDir, slug(task.id));
  await mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(task.setup ?? {})) {
    const target = join(dir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }

  const events: AgentEvent[] = [];
  const emit = createEmitter(`eval_${slug(task.id)}`, (e) => events.push(e));
  const started = Date.now();
  let result: AgentResult;
  try {
    result = await runAgent({
      llm: opts.llm,
      model: opts.modelLabel,
      systemPrompt: opts.systemPrompt,
      message: task.prompt,
      sessionId: `eval_${slug(task.id)}`,
      workspace: dir,
      limits: { maxSteps: opts.maxSteps, maxCostUsd: opts.maxCostUsd },
      prices: opts.prices,
      emit,
      approve: async () => false, // eval never runs unapproved commands
      history: task.history,
    });
  } catch (err) {
    return {
      id: task.id,
      category: task.category,
      title: task.title,
      status: "fail",
      details: `runAgent error: ${err instanceof Error ? err.message : String(err)}`,
      agentStatus: "error",
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      durationMs: Date.now() - started,
    };
  }

  const outcome = await task.check({
    workspace: dir,
    events,
    summary: result.summary,
    status: result.status,
    filesCreated: result.filesCreated,
    filesChanged: result.filesChanged,
  });
  return {
    id: task.id,
    category: task.category,
    title: task.title,
    status: outcome.passed ? "pass" : "fail",
    details: outcome.details,
    manual: outcome.manual,
    agentStatus: result.status,
    steps: result.totals.steps,
    inputTokens: result.totals.input_tokens,
    outputTokens: result.totals.output_tokens,
    costUsd: result.totals.cost_usd,
    durationMs: result.durationMs,
  };
}

export async function runEvalSuite(opts: RunEvalOptions): Promise<{
  report: EvalReport;
  logPath: string;
}> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const skipNetwork = opts.skipNetwork ?? opts.mode === "dummy";
  const tasks = TASKS.filter((t) => !opts.only || opts.only.includes(t.id));
  if (tasks.length === 0) throw new Error("tidak ada tugas yang cocok dengan filter");

  const date = startedAt.slice(0, 10);
  const runDir = resolve(opts.workspaceRoot, "evals", date);
  await mkdir(runDir, { recursive: true });
  const outDir = resolve(opts.outDir ?? join(opts.workspaceRoot, ".bikinin", "evals"));
  await mkdir(outDir, { recursive: true });

  const results: EvalTaskResult[] = [];
  for (const task of tasks) {
    if (task.requiresNetwork && skipNetwork) {
      results.push({
        id: task.id,
        category: task.category,
        title: task.title,
        status: "skip",
        details: "butuh network (web_search); di-skip jujur di mode dummy",
        agentStatus: "skipped",
        steps: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        durationMs: 0,
      });
      continue;
    }
    const llm =
      opts.mode === "dummy"
        ? createDummyLlm(planFirstScript(task))
        : opts.llmFor(task);
    results.push(
      await runEvalTask(task, {
        workspaceRoot: opts.workspaceRoot,
        systemPrompt: opts.systemPrompt,
        llm,
        modelLabel: opts.modelLabel,
        maxSteps: opts.maxSteps ?? 30,
        maxCostUsd: opts.maxCostUsd ?? 0.5,
        prices: opts.prices ?? { inPerM: 0, outPerM: 0 },
        runDir,
      }),
    );
  }

  const attempted = results.filter((r) => r.status !== "skip");
  const passed = results.filter((r) => r.status === "pass").length;
  const report: EvalReport = {
    version: 1,
    mode: opts.mode,
    model: opts.modelLabel,
    startedAt,
    finishedAt: new Date().toISOString(),
    totals: {
      tasks: results.length,
      passed,
      failed: results.filter((r) => r.status === "fail").length,
      skipped: results.filter((r) => r.status === "skip").length,
      scorePct:
        attempted.length === 0
          ? 0
          : Math.round((passed / attempted.length) * 1000) / 10,
      durationMs: Date.now() - startedMs,
      inputTokens: results.reduce((a, r) => a + r.inputTokens, 0),
      outputTokens: results.reduce((a, r) => a + r.outputTokens, 0),
      costUsd: results.reduce((a, r) => a + r.costUsd, 0),
    },
    results,
  };

  const logPath = join(outDir, `${date}.json`);
  await writeFile(logPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  return { report, logPath };
}
