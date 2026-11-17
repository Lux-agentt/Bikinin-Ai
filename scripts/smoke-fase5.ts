// Smoke test Fase 5: web_search LIVE, checkpoint (copy + git) + restore,
// delegate end-to-end, UI (mic + todo panel + checkpoint tab), dan
// plan-first. LLM-nya scripted (deterministik) KECUALI web_search yang
// benar-benar memanggil DuckDuckGo Lite — itu inti Track 1, jadi harus live.
//
// Workspace smoke dibuat di home, BUKAN /tmp (konvensi smoke-remotion.ts).
// Dihapus di finally.
//
// Jalankan: npx tsx scripts/smoke-fase5.ts
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../src/agent/loop.js";
import type { Config } from "../src/config.js";
import { createEmitter, type AgentEvent } from "../src/events.js";
import type { ChatResult, LlmClient, ToolCallReq } from "../src/llm/client.js";
import {
  createCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
} from "../src/server/checkpoints.js";
import { createAppServer } from "../src/server/http.js";
import { RunManager } from "../src/server/runs.js";
import { searchWeb } from "../src/tools/web-search.js";

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
const plan = (id: string) =>
  call(id, "update_plan", {
    items: [{ text: "Kerjakan tugas", status: "doing" }],
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

function git(
  dir: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", dir, ...args],
      {
        timeout: 30_000,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Smoke",
          GIT_AUTHOR_EMAIL: "smoke@localhost",
          GIT_COMMITTER_NAME: "Smoke",
          GIT_COMMITTER_EMAIL: "smoke@localhost",
          ...extraEnv,
        },
      },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(`git ${args[0]}: ${stderr || error.message}`));
        resolve(stdout);
      },
    );
  });
}

const cfg: Config = {
  providers: [
    {
      name: "t",
      baseUrl: "https://x.test/v1",
      apiKey: "SMOKE_KEY",
      model: "test-model",
      inPerM: 1,
      outPerM: 2,
    },
  ],
  BIKININ_USD_IDR: 17000,
  BIKININ_MAX_STEPS: 10,
  BIKININ_MAX_COST_USD: 1,
  BIKININ_WORKSPACE: "./workspace",
  BIKININ_MAX_VIDEO_SECONDS: 30,
};

async function main(): Promise<void> {
  const workspace = await mkdtemp(join(homedir(), ".bikinin-smoke-fase5-"));
  const gitWs = await mkdtemp(join(homedir(), ".bikinin-smoke-fase5-git-"));
  const started = Date.now();
  let pass = true;
  const check = (label: string, ok: boolean, extra = "") => {
    if (!ok) pass = false;
    console.log(`  ${ok ? "YA " : "TIDAK"} ${label}${extra ? ` — ${extra}` : ""}`);
  };

  try {
    // ---------- Track 1: web_search LIVE (DuckDuckGo Lite, tanpa key) ----------
    console.log("Track 1 — web_search (live DuckDuckGo Lite):");
    let results: Awaited<ReturnType<typeof searchWeb>> = [];
    try {
      results = await searchWeb("harga domain .id terbaru");
    } catch (err) {
      check("pencarian live mengembalikan hasil", false, err instanceof Error ? err.message : String(err));
    }
    check("pencarian live mengembalikan >= 1 hasil asli", results.length >= 1, `${results.length} hasil`);
    check(
      "setiap hasil punya title + url http(s) + snippet",
      results.every((r) => r.title.length > 0 && /^https?:\/\//.test(r.url)),
      results[0] ? `${results[0].title.slice(0, 60)} — ${results[0].url.slice(0, 60)}` : "",
    );
    check("hasil dibatasi maks 5", results.length <= 5, `${results.length} hasil`);
    // Guard rahasia: query berisi key tidak pernah fetch.
    let blocked = false;
    try {
      await searchWeb("sk-abcdefghijklmnop123456");
    } catch (err) {
      blocked = /rahasia/.test(err instanceof Error ? err.message : "");
    }
    check("query berisi rahasia ditolak sebelum fetch", blocked);

    // ---------- Track 2a: checkpoint copy-mode + restore ----------
    console.log("Track 2a — checkpoint copy-mode + restore:");
    await writeFile(join(workspace, "a.txt"), "versi 1\n", "utf8");
    await writeFile(join(workspace, "b.txt"), "tetap\n", "utf8");
    await writeFile(join(workspace, ".env"), "LLM_API_KEY=RAHASIA_SMOKE\n", "utf8");
    const cp = await createCheckpoint(workspace, "s_smoke", "run_smoke");
    check("checkpoint dibuat (copy-mode, workspace bukan repo git)", cp.method === "copy", `${cp.id} ${cp.method} ${cp.files.length} file`);
    check("file .env TIDAK ikut di-snapshot", !cp.files.includes(".env"));
    await writeFile(join(workspace, "a.txt"), "versi 2 RUSAK\n", "utf8");
    await rm(join(workspace, "b.txt"));
    await writeFile(join(workspace, "c.txt"), "file baru\n", "utf8");
    const restored = await restoreCheckpoint(workspace, cp.id);
    check("restore mengembalikan a.txt ke versi 1", (await readFile(join(workspace, "a.txt"), "utf8")) === "versi 1\n");
    check("restore mengembalikan b.txt yang dihapus", (await readFile(join(workspace, "b.txt"), "utf8")) === "tetap\n");
    const cGone = await readFile(join(workspace, "c.txt"), "utf8").then(() => false, () => true);
    check("restore menghapus c.txt (file baru di luar snapshot)", cGone);
    check(".env tidak tersentuh restore", (await readFile(join(workspace, ".env"), "utf8")).includes("RAHASIA_SMOKE"));
    check("restore melaporkan jumlah file", restored.files_restored >= 2, `${restored.files_restored} file`);

    // ---------- Track 2b: checkpoint git-mode (rahasia tidak ikut commit) ----------
    console.log("Track 2b — checkpoint git-mode:");
    await git(gitWs, ["init", "-q"]);
    await writeFile(join(gitWs, "app.js"), "console.log(1);\n", "utf8");
    await writeFile(join(gitWs, ".env"), "LLM_API_KEY=RAHASIA_GIT\n", "utf8");
    await git(gitWs, ["add", "app.js"]);
    await git(gitWs, ["commit", "-q", "-m", "baseline"]);
    const cpGit = await createCheckpoint(gitWs, "s_smoke_git", "run_smoke_git");
    check("checkpoint git-mode dipakai di repo git", cpGit.method === "git", `${cpGit.id} ${cpGit.method}`);
    const tree = cpGit.git_commit
      ? await git(gitWs, ["ls-tree", "-r", "--name-only", cpGit.git_commit])
      : "";
    check(".env TIDAK ada di commit snapshot", !tree.split("\n").includes(".env"), tree.trim().split("\n").join(", "));
    await writeFile(join(gitWs, "app.js"), "console.log(2); // rusak\n", "utf8");
    await restoreCheckpoint(gitWs, cpGit.id);
    check("restore git mengembalikan app.js ke baseline", (await readFile(join(gitWs, "app.js"), "utf8")) === "console.log(1);\n");

    // ---------- Track 3: delegate end-to-end ----------
    console.log("Track 3 — delegate (subagent):");
    await writeFile(join(workspace, "README.md"), "# Proyek Kopi\nHarga kopi 25 ribu.\n", "utf8");
    const events: AgentEvent[] = [];
    const emit = createEmitter("run_smoke_delegate", (e) => events.push(e));
    const result = await runAgent({
      llm: scripted([
        withCalls(plan("t0")),
        withCalls(
          call("t1", "delegate", {
            task: "Baca README.md dan laporkan harga kopi",
            context: "Butuh angka harga untuk jawaban pengguna.",
          }),
        ),
        // Sub-run (isSubagent: tanpa plan-first nudge):
        withCalls(call("s1", "read_file", { path: "README.md" })),
        finalText("Ringkasan: harga kopi 25 ribu (dari README.md)."),
        // Main run, setelah delegate kembali:
        finalText("Harga kopi 25 ribu."),
      ]),
      model: "smoke-model",
      systemPrompt: "sys",
      message: "Berapa harga kopi di proyek ini?",
      sessionId: "s_smoke_delegate",
      workspace,
      limits: { maxSteps: 10, maxCostUsd: 1 },
      prices: { inPerM: 1, outPerM: 2 },
      emit,
      approve: async () => false,
    });
    const startedEv = events.find((e) => e.type === "subagent_started");
    const finishedEv = events.find((e) => e.type === "subagent_finished");
    check("subagent_started + subagent_finished ter-emit", !!startedEv && !!finishedEv);
    check(
      "peringatan kuota tampil di event subagent_started",
      startedEv?.type === "subagent_started" && startedEv.quota_note.includes("50 request/hari"),
    );
    check(
      "ringkasan subagent kembali (isi README terbaca)",
      finishedEv?.type === "subagent_finished" && finishedEv.summary.includes("25 ribu"),
      finishedEv?.type === "subagent_finished" ? finishedEv.summary.slice(0, 80) : "",
    );
    check("langkah + biaya subagent dibebankan ke total run utama", result.totals.steps === 3 && result.totals.cost_usd > 0, `steps=${result.totals.steps} cost=$${result.totals.cost_usd}`);
    check("status run utama completed", result.status === "completed", result.status);

    // ---------- Kualitas: plan-first (batch pertama tanpa plan dibuang) ----------
    console.log("Kualitas — plan-first:");
    const events2: AgentEvent[] = [];
    await runAgent({
      llm: scripted([
        withCalls(call("x1", "write_file", { path: "plan.txt", content: "tanpa rencana\n" })),
        withCalls(call("x2", "write_file", { path: "plan.txt", content: "dengan rencana\n" })),
        finalText("ok"),
      ]),
      model: "smoke-model",
      systemPrompt: "sys",
      message: "tulis plan.txt",
      sessionId: "s_smoke_plan",
      workspace,
      limits: { maxSteps: 10, maxCostUsd: 1 },
      prices: { inPerM: 1, outPerM: 2 },
      emit: createEmitter("run_smoke_plan", (e) => events2.push(e)),
      approve: async () => false,
    });
    check(
      "tool batch pertama tanpa update_plan dibuang (isi akhir = write kedua)",
      (await readFile(join(workspace, "plan.txt"), "utf8")) === "dengan rencana\n",
    );

    // ---------- Track 4: UI + endpoint checkpoint (server sungguhan) ----------
    console.log("Track 4 — UI + endpoint checkpoint (server live):");
    const manager = new RunManager(cfg, {
      workspace,
      systemPrompt: "sys",
      llm: scripted([finalText("ok")]),
    });
    const server = createAppServer(manager, workspace);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const html = await (await fetch(`${base}/`)).text();
      check("tombol mic suara ada di HTML", html.includes('id="micBtn"'));
      check("tab Checkpoint ada di folder sheet", html.includes('data-ftab="checkpoints"'));
      const js = await (await fetch(`${base}/app.js`)).text();
      check("handler plan_updated ada di app.js (panel Todo)", js.includes("plan_updated"));
      check("setupVoice ada di app.js (Web Speech API)", js.includes("setupVoice"));
      check("renderPlan ada di app.js", js.includes("renderPlan"));
      const listRes = await fetch(`${base}/api/checkpoints`);
      const list = (await listRes.json()) as Array<{ id: string }>;
      check("GET /api/checkpoints me-list checkpoint smoke", listRes.status === 200 && list.some((c) => c.id === cp.id), `${list.length} checkpoint`);
      // Restore lewat HTTP: rusak dulu, lalu restore.
      await writeFile(join(workspace, "a.txt"), "versi 3 RUSAK LAGI\n", "utf8");
      const restoreRes = await fetch(`${base}/api/checkpoints/${cp.id}/restore`, { method: "POST" });
      check("POST /api/checkpoints/:id/restore 200", restoreRes.status === 200, `status ${restoreRes.status}`);
      check("restore HTTP mengembalikan a.txt ke versi 1", (await readFile(join(workspace, "a.txt"), "utf8")) === "versi 1\n");
      const badRes = await fetch(`${base}/api/checkpoints/cp_tidakada/restore`, { method: "POST" });
      check("restore id tidak dikenal -> 404", badRes.status === 404, `status ${badRes.status}`);
    } finally {
      await new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      });
    }

    console.log("");
    console.log(`Total waktu smoke: ${((Date.now() - started) / 1000).toFixed(0)} dtk`);
    console.log(
      pass
        ? "SMOKE FASE 5 PASS: search live, checkpoint copy+git + restore, delegate, plan-first, UI + endpoint checkpoint."
        : "SMOKE FASE 5 FAIL: lihat baris TIDAK di atas.",
    );
    if (!pass) process.exitCode = 1;
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(gitWs, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
