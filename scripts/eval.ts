// Eval benchmark (Fase 7): `npm run eval` — runs the 16 standard tasks
// against a model and prints per-task + total scores, time, tokens, cost.
// Dummy mode (default): scripted model, zero cost, no key, no network —
// verifies the harness. Live mode: `--model <nama-provider>` uses that
// provider from .env (fallback chain NOT used: one provider per run).
// Network tasks are skipped honestly in dummy mode, never faked.
// Logs go to <workspace>/.bikinin/evals/<tanggal>-<jam>.json (one file per run, outside the repo).
//
//   npm run eval                          # dummy, all tasks
//   npm run eval -- --model or-north      # live, one provider
//   npm run eval -- --tasks bugfix-off-by-one,behavior-vague
//   npm run eval -- --out-dir /tmp/evals  # custom log dir
//   npm run eval -- --list                # list tasks, run nothing
//   npm run eval -- --strict              # exit 1 if any attempted task fails
import { mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertWorkspaceIsolated } from "../src/safety/paths.js";
import { loadConfig, type Config } from "../src/config.js";
import { runEvalSuite } from "../src/eval/runner.js";
import { TASKS } from "../src/eval/tasks.js";
import { createFallbackLlm } from "../src/llm/fallback.js";
import { importEvalReport } from "../src/llm/router.js";
import { loadSystemPrompt } from "../src/prompt.js";

/** Dummy mode must work with no .env and no key (CI); live mode needs config. */
function loadEvalConfig(modelName?: string): Config {
  try {
    return loadConfig();
  } catch (err) {
    if (modelName) throw err;
    console.log(
      "Tanpa .env: mode dummy memakai default (workspace di luar repo, 30 langkah, $0.50).",
    );
    return {
      BIKININ_USD_IDR: 17000,
      BIKININ_MAX_COST_USD: 0.5,
      BIKININ_WORKSPACE: join(tmpdir(), "bikinin-eval-workspace"),
      BIKININ_MAX_VIDEO_SECONDS: 30,
      providers: [],
    };
  }
}

function usage(): void {
  console.error(
    "Pemakaian: npm run eval [-- --model <nama-provider>] [--tasks <id,id>] [--out-dir <dir>] [--list] [--strict]",
  );
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const has = (name: string) => args.includes(name);

  if (has("--list")) {
    for (const t of TASKS)
      console.log(
        `${t.id.padEnd(26)} [${t.category.padEnd(8)}] ${t.title}${t.requiresNetwork ? " (butuh network)" : ""}`,
      );
    console.log(`${TASKS.length} tugas.`);
    return 0;
  }

  const modelName = flag("--model");
  const only = flag("--tasks")?.split(",").map((s) => s.trim()).filter(Boolean);
  const outDir = flag("--out-dir");
  const strict = has("--strict");

  if (only) {
    const unknown = only.filter((id) => !TASKS.some((t) => t.id === id));
    if (unknown.length > 0) {
      console.error(`Tugas tidak dikenal: ${unknown.join(", ")}`);
      usage();
      return 2;
    }
  }

  const cfg = loadEvalConfig(modelName);
  await assertWorkspaceIsolated(
    await realpath(cfg.BIKININ_WORKSPACE).catch(() => cfg.BIKININ_WORKSPACE),
  );
  const systemPrompt = await loadSystemPrompt();
  const workspaceRoot = await realpath(cfg.BIKININ_WORKSPACE).catch(() =>
    resolve(cfg.BIKININ_WORKSPACE),
  );
  await mkdir(workspaceRoot, { recursive: true });

  const mode = modelName ? "live" : "dummy";
  let modelLabel = "dummy (scripted)";
  let prices = { inPerM: 0, outPerM: 0 };
  let llmFor: Parameters<typeof runEvalSuite>[0]["llmFor"] = () => {
    throw new Error("mode dummy tidak memakai llmFor");
  };
  if (modelName) {
    const provider = cfg.providers.find((p) => p.name === modelName);
    if (!provider) {
      console.error(
        `Provider "${modelName}" tidak ada. Pilihan: ${cfg.providers.map((p) => p.name).join(", ")}`,
      );
      return 2;
    }
    modelLabel = `${provider.name} (${provider.model})`;
    prices = { inPerM: provider.inPerM, outPerM: provider.outPerM };
    llmFor = () => createFallbackLlm([provider]);
  }

  console.log(
    `Eval Fase 7 — mode ${mode}, model ${modelLabel}, ${only ? `${only.length} tugas terpilih` : `${TASKS.length} tugas`}`,
  );
  const { report, logPath } = await runEvalSuite({
    workspaceRoot,
    systemPrompt,
    llmFor,
    modelLabel,
    mode,
    maxCostUsd: cfg.BIKININ_MAX_COST_USD,
    prices,
    outDir,
    only,
  });

  console.table(
    report.results.map((r) => ({
      tugas: r.id,
      hasil: r.status === "pass" ? "LOLOS" : r.status === "fail" ? "GAGAL" : "SKIP",
      langkah: r.steps,
      token_in: r.inputTokens,
      token_out: r.outputTokens,
      biaya_usd: Number(r.costUsd.toFixed(5)),
      waktu_dtk: Number((r.durationMs / 1000).toFixed(1)),
      detail: r.details,
    })),
  );
  const t = report.totals;
  console.log(
    `Total: ${t.passed} lolos / ${t.failed} gagal / ${t.skipped} skip dari ${t.tasks} tugas — skor ${t.scorePct}% (atas tugas yang dicoba), ` +
      `${t.inputTokens} token in, ${t.outputTokens} token out, $${t.costUsd.toFixed(5)}, ${(t.durationMs / 1000).toFixed(1)} dtk`,
  );
  console.log(`Log: ${logPath}`);
  if (mode === "live") {
    // Fase 8: hasil eval live masuk ke tabel kemenangan router, supaya
    // routing berikutnya berbasis data, bukan cuma heuristik. Mode dummy
    // sengaja tidak diimpor (skor dummy bukan ukuran kemampuan model).
    const imported = await importEvalReport(workspaceRoot, report).catch(
      () => 0,
    );
    console.log(
      `Router: ${imported} hasil eval dicatat ke tabel kemenangan.`,
    );
  }
  if (mode === "dummy")
    console.log(
      "Catatan: mode dummy memverifikasi harness (skor dummy bukan ukuran kemampuan model).",
    );
  for (const r of report.results)
    if (r.manual) console.log(`  manual — ${r.id}: ${r.manual}`);

  return strict && t.failed > 0 ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
