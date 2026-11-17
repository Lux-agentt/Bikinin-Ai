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
      BIKININ_MAX_STEPS: 30,
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
  });
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
