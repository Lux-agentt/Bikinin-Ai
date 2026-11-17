import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { z } from "zod";
import { AgentError } from "../errors.js";
import { classifyCommand } from "../safety/commands.js";
import { defineTool } from "./types.js";

const TIMEOUT_MS = 120_000;
const MAX_BUFFER = 2 * 1024 * 1024;
const SECRET_NAME = /KEY|TOKEN|SECRET|PASS|CRED/i;

// Variabel yang mengubah perilaku proses anak tanpa mengubah perintahnya:
// loader (LD_PRELOAD dkk. = injeksi .so), Node (NODE_OPTIONS bisa
// --require file arbitrer; NODE_PATH/NODE_EXTRA_CA_CERTS mengubah resolusi
// modul dan trust TLS), git (GIT_DIR dkk. memindahkan repo/index/config),
// shell (CDPATH mengubah arti cd; IFS mengubah word splitting;
// ENV/BASH_ENV menjalankan file startup), dan NPM_CONFIG_* (registry dkk.).
// HOME dan PATH sengaja TIDAK dibuang: keduanya berasal dari env server
// operator (trust domain yang sama dengan proses server — anak proses tidak
// bisa mengubah env server), dan npm/node butuh keduanya (PATH berisi lokasi
// node, mis. nvm; HOME dipakai npm/git untuk cache/konfigurasi). Assignment
// inline PATH=/HOME= di string perintah tetap diblokir classifier.
const BLOCKED_ENV_NAME =
  /^(LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_COMMON_DIR|GIT_CONFIG|GIT_CONFIG_COUNT|GIT_CONFIG_PARAMETERS|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_SSH|GIT_SSH_COMMAND|GIT_ASKPASS|GIT_EDITOR|GIT_PAGER|GIT_CEILING_DIRECTORIES|CDPATH|IFS|ENV|BASH_ENV)$/i;
const BLOCKED_ENV_PREFIX = /^NPM_CONFIG_/i;

/** Child processes never inherit secrets from the parent environment. */
export function safeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) =>
        !SECRET_NAME.test(name) &&
        !BLOCKED_ENV_NAME.test(name) &&
        !BLOCKED_ENV_PREFIX.test(name),
    ),
  );
}

interface ShellResult {
  ok: boolean;
  killed: boolean;
  code: number;
  output: string;
}

function execShell(command: string, cwd: string): Promise<ShellResult> {
  return new Promise((resolve) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      {
        cwd,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        env: { ...safeEnv(process.env), GIT_CEILING_DIRECTORIES: dirname(cwd) },
      },
      (error, stdout, stderr) => {
        const code =
          typeof error?.code === "number" ? error.code : error ? 1 : 0;
        const output = [stdout, stderr ? `[stderr]\n${stderr}` : ""]
          .filter(Boolean)
          .join("\n");
        resolve({ ok: !error, killed: Boolean(error?.killed), code, output });
      },
    );
  });
}

export const runCommandTool = defineTool({
  name: "run_command",
  description:
    "Jalankan perintah shell di folder workspace (timeout 120 dtk). Perintah di luar allowlist butuh persetujuan pengguna.",
  parameters: {
    type: "object",
    properties: { command: { type: "string", description: "Perintah shell" } },
    required: ["command"],
    additionalProperties: false,
  },
  readOnly: false,
  schema: z.object({ command: z.string().trim().min(1).max(2000) }),
  label: (a) => `$ ${a.command.slice(0, 80)}`,
  publicArgs: (a) => ({ command: a.command }),
  gate: (a) => classifyCommand(a.command),
  async run(a, ctx) {
    // Re-check here too: defense in depth if the loop's gate is ever bypassed.
    const verdict = classifyCommand(a.command);
    if (verdict.decision === "block")
      throw new AgentError("command_blocked", verdict.reason);

    const r = await execShell(a.command, ctx.workspace);
    const summary = r.killed
      ? "timeout (120 dtk)"
      : r.ok
        ? "selesai (exit 0)"
        : `gagal (exit ${r.code})`;
    return { ok: r.ok, summary, output: r.output, changes: [] };
  },
});
