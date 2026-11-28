// Web UI entry point: `npm run serve -- --port 3000`. Bind to localhost; Codespaces forwards the port.
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertWorkspaceIsolated } from "./safety/paths.js";
import { loadConfig, type Config } from "./config.js";
import { loadSystemPrompt } from "./prompt.js";
import { createAppServer } from "./server/http.js";
import { RunManager } from "./server/runs.js";
import { formatSkillList, listSkills, REPO_SKILLS_DIR } from "./skills/loader.js";

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const port = Number(flag("--port", "3000"));
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("--port harus 1-65535");
  const host = flag("--host", "127.0.0.1");

  // The UI must start even before an LLM provider is configured, so the owner
  // can open it from a phone and see the real state. Runs stay impossible
  // until .env is filled in (POST /api/runs answers 503, honestly).
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.warn(
      "LLM belum dikonfigurasi — UI tetap berjalan, run agent butuh .env:",
      err instanceof Error ? err.message.split("\n")[0] : err,
    );
    cfg = {
      providers: [],
      BIKININ_USD_IDR: 17000,
      BIKININ_MAX_COST_USD: 0.5,
      BIKININ_WORKSPACE:
        process.env.BIKININ_WORKSPACE ?? join(homedir(), "bikinin-workspace"),
      BIKININ_MAX_VIDEO_SECONDS: 30,
    };
  }
  await mkdir(cfg.BIKININ_WORKSPACE, { recursive: true });
  const workspace = await realpath(cfg.BIKININ_WORKSPACE);
  await assertWorkspaceIsolated(workspace);
  const manager = new RunManager(cfg, {
    workspace,
    // Fase 2: the system prompt lists available skills (name + description
    // only); the agent reads the full text with read_skill when relevant.
    systemPrompt: await loadSystemPrompt(
      formatSkillList(await listSkills(REPO_SKILLS_DIR)),
    ),
    // Fase 8 (hot reload): the skill list is re-listed fresh before each
    // run (see RunManager.execute), so a new skills/ folder appears in the
    // next run without restarting the server. A broken skill is skipped by
    // listSkills, never fatal.
    buildSystemPrompt: async () =>
      loadSystemPrompt(formatSkillList(await listSkills(REPO_SKILLS_DIR))),
  });
  // Fase 8: watch skills/ and say so when it changes — the next run picks
  // the change up via buildSystemPrompt above. Best-effort only: a watcher
  // failure must never stop the server.
  try {
    const { watch } = await import("node:fs");
    const watcher = watch(REPO_SKILLS_DIR, (event, filename) => {
      console.log(
        `Skill berubah (${event}${filename ? `: ${filename}` : ""}) — dipakai di run berikutnya tanpa restart.`,
      );
    });
    watcher.on("error", () => {
      /* watcher is informational only; runs re-list skills anyway */
    });
    watcher.unref?.();
  } catch {
    /* no watcher (e.g. skills dir unreadable); runs re-list skills anyway */
  }
  // Restore sessions + metadata saved by earlier runs (workspace/.bikinin/).
  const restored = await manager.init();
  if (restored > 0)
    console.log(`Memori dimuat: ${restored} sesi lama dipulihkan.`);

  createAppServer(manager, workspace).listen(port, host, () => {
    console.log(`Bikinin AI: http://${host}:${port}`);
    console.log(
      "Di Codespaces: buka tab Ports, pastikan visibilitas Private, lalu klik port ini.",
    );
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
