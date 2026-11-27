import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, sep } from "node:path";
import { z } from "zod";
import { AgentError } from "../errors.js";
import { classifyCommand } from "../safety/commands.js";
import { defineTool } from "./types.js";

const TIMEOUT_MS = 120_000;
const MAX_BUFFER = 2 * 1024 * 1024;
// Fase 9: instalasi dependensi memang lambat dan berisik — batas longgar
// khusus jalur install (di luar sandbox, lihat isInstallCommand).
const INSTALL_TIMEOUT_MS = 300_000;
const INSTALL_MAX_BUFFER = 8 * 1024 * 1024;
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

/* ---------- sandbox (Fase 8): user namespace via unshare ---------- */

// Penanda bahwa skrip setup di dalam namespace gagal sebelum perintah agent
// sempat jalan. Dibedakan dari exit code perintah itu sendiri (perintah yang
// gagal tidak pernah mencetak penanda ini).
const SANDBOX_SETUP_FAILED = "BIKININ_SANDBOX_SETUP_FAILED";

// Setup dijalankan /bin/sh -c dengan $1=workspace (realpath), $2=perintah
// agent, $3=staging dir. Urutan penting:
//  1. make-rprivate: mount di bawah ini tidak bocor ke host (tanpa ini,
//     bind/tmpfs bisa menular ke mount namespace induk).
//  2. Bind workspace ke staging, lalu remount / read-only, lalu remount
//     staging read-write — jadi satu-satunya tempat yang bisa ditulis adalah
//     workspace (dan tmpfs segar di bawah).
//  3. Tutup /etc, /root, /home, /tmp dengan tmpfs kosong: file di luar
//     workspace tidak bisa dibaca (bukan cuma tidak bisa ditulis), dan
//     tulisan ke sana hilang bersama namespace.
//  4. HOME baru di dalam /tmp segar (npm butuh HOME yang bisa ditulis);
//     env rahasia sudah dibuang safeEnv sebelum unshare dipanggil.
//  5. Net namespace kosong (unshare --net): tanpa interface, tanpa network.
//     Tool yang memang butuh network (web_search) tidak lewat sini.
//  6. PID namespace sendiri (--pid --fork): saat init namespace mati,
//     kernel membunuh semua proses di dalamnya.
const SANDBOX_SETUP_SCRIPT = [
  'WS="$1"',
  'CMD="$2"',
  'STAGE="$3"',
  "setup() {",
  '  mkdir -p "$STAGE" || return 1',
  "  mount --make-rprivate / || return 1",
  '  mount --bind "$WS" "$STAGE" || return 1',
  "  mount -o remount,ro,bind / || return 1",
  '  mount -o remount,rw,bind "$STAGE" || return 1',
  "  for d in /etc /root /home /tmp; do",
  '    if [ -d "$d" ]; then mount -t tmpfs tmpfs "$d" || return 1; fi',
  "  done",
  "  mkdir -p /tmp/.bikinin-home || return 1",
  "}",
  "if setup; then",
  "  export HOME=/tmp/.bikinin-home",
  `  cd "$STAGE" || { echo "${SANDBOX_SETUP_FAILED}" >&2; exit 43; }`,
  '  exec /bin/sh -c "$CMD"',
  "else",
  `  echo "${SANDBOX_SETUP_FAILED}" >&2`,
  "  exit 42",
  "fi",
].join("\n");

/**
 * BIKININ_SANDBOX=off/0/false mematikan sandbox (perintah jalan langsung
 * seperti sebelum Fase 8, hanya dijaga classifier + cwd jail). Nilai lain
 * atau tidak di-set: sandbox nyala. Matikan hanya bila mesin memang tidak
 * punya user namespace — jangan dipakai untuk lolos dari batas.
 */
export function sandboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.BIKININ_SANDBOX ?? "").trim().toLowerCase();
  return raw !== "off" && raw !== "0" && raw !== "false";
}

/**
 * Fase 9: perintah instalasi dependensi TUNGGAL — `npm install`, `npm ci`,
 * `npm i` (plus argumen apa pun, mis. nama paket atau flag), dan setaranya
 * di pnpm/yarn. Perintah ini butuh network (registry), jadi dijalankan di
 * luar sandbox — lihat run(). Perintah majemuk (mengandung &&, ;, |, atau
 * baris baru) BUKAN install murni: tetap sandboxed, model harus memecahnya
 * jadi dua panggilan. Classifier tetap jalan duluan di run(), jadi pola
 * berbahaya di dalam perintah install (path absolut, $(...), assignment
 * env) tetap diblokir sebelum apa pun dieksekusi.
 */
export function isInstallCommand(command: string): boolean {
  const cmd = command.trim();
  if (/[;&|\n]/.test(cmd)) return false;
  return /^(?:npm\s+(?:install|i|ci)|pnpm\s+(?:install|i)|yarn\s+install)(?:\s|$)/.test(
    cmd,
  );
}

/**
 * Tempat staging bind-mount workspace di dalam sandbox. /mnt dipilih karena
 * hampir selalu ada dan kosong; bila workspace sendiri ada di bawah /mnt,
 * pakai /var supaya staging tidak jatuh di dalam workspace.
 */
export function sandboxStageDir(workspaceAbs: string): string {
  const underMnt =
    workspaceAbs === "/mnt" || workspaceAbs.startsWith("/mnt" + sep);
  return underMnt ? "/var/.bikinin-ws" : "/mnt/.bikinin-ws";
}

function sandboxFailure(output: string): AgentError {
  return new AgentError(
    "tool_failed",
    "sandbox gagal disiapkan (user/mount namespace). Perintah TIDAK dijalankan. " +
      "Periksa dukungan user namespace di mesin ini, atau set BIKININ_SANDBOX=off " +
      "untuk menjalankan perintah tanpa sandbox (hanya classifier + cwd jail yang menjaga).\n" +
      output.slice(-1000),
  );
}

/**
 * Jalankan perintah di dalam user+mount+net+pid namespace (unshare).
 * Gagal menyiapkan namespace = throw, bukan jalan tanpa sandbox.
 * Diekspor untuk test: memanggil fungsi ini langsung melewati classifier
 * dengan sengaja, supaya test membuktikan lapis sandbox itu sendiri.
 */
export async function execSandboxed(
  command: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<ShellResult> {
  let ws: string;
  try {
    ws = await realpath(cwd);
  } catch {
    throw new AgentError("tool_failed", `workspace tidak ditemukan: ${cwd}`);
  }
  if (ws === "/")
    throw new AgentError(
      "tool_failed",
      "workspace tidak bisa di-sandbox: root filesystem (/) bukan workspace yang valid",
    );
  const stage = sandboxStageDir(ws);
  return new Promise((resolve, reject) => {
    execFile(
      "unshare",
      [
        "--user",
        "--map-root-user",
        "--mount",
        "--net",
        "--pid",
        "--fork",
        "/bin/sh",
        "-c",
        SANDBOX_SETUP_SCRIPT,
        "bikinin-sandbox",
        ws,
        command,
        stage,
      ],
      {
        cwd: ws,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        // Stop membunuh proses luar (unshare); proses di dalam namespace
        // yang sudah jalan tidak ikut mati, tapi janji ini selesai dan
        // timeout 120 dtk tetap jadi batas atasnya.
        signal,
        env: {
          ...safeEnv(process.env),
          HOME: "/tmp/.bikinin-home",
          GIT_CEILING_DIRECTORIES: dirname(ws),
        },
      },
      (error, stdout, stderr) => {
        const output = [stdout, stderr ? `[stderr]\n${stderr}` : ""]
          .filter(Boolean)
          .join("\n");
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(
            new AgentError(
              "tool_failed",
              "sandbox tidak tersedia: perintah 'unshare' tidak ditemukan di mesin ini. " +
                "Jalankan di mesin dengan user namespace, atau set BIKININ_SANDBOX=off " +
                "untuk menjalankan perintah tanpa sandbox (hanya classifier + cwd jail yang menjaga).",
            ),
          );
          return;
        }
        // Setup gagal (penanda dari skrip), atau unshare sendiri gagal
        // sebelum masuk namespace (mis. user namespace ditolak kernel):
        // perintah agent tidak jalan — laporkan sebagai kegagalan sandbox,
        // bukan sebagai kegagalan perintah.
        if (
          output.includes(SANDBOX_SETUP_FAILED) ||
          /^unshare: /m.test(output)
        ) {
          reject(sandboxFailure(output));
          return;
        }
        const code =
          typeof error?.code === "number" ? error.code : error ? 1 : 0;
        resolve({ ok: !error, killed: Boolean(error?.killed), code, output });
      },
    );
  });
}

function execShell(
  command: string,
  cwd: string,
  timeoutMs = TIMEOUT_MS,
  maxBuffer = MAX_BUFFER,
  signal?: AbortSignal,
): Promise<ShellResult> {
  return new Promise((resolve) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer,
        signal,
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
    "Jalankan perintah shell di folder workspace (timeout 120 dtk), di dalam sandbox user-namespace: tanpa network, filesystem di luar workspace read-only/tersembunyi, env dibersihkan dari rahasia. Pengecualian Fase 9: perintah instalasi dependensi tunggal (npm install/ci/i, pnpm install, yarn install) jalan di luar sandbox supaya bisa mengakses registry — tetap dengan classifier yang sama dan env yang di-scrub, tapi postinstall script ikut jalan di luar sandbox. Perintah di luar allowlist butuh persetujuan pengguna.",
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

    // Fase 9: instalasi dependensi butuh network (registry) — jalankan di
    // luar sandbox via execShell (cwd tetap workspace, env tetap safeEnv).
    // Perintah install verdict-nya "confirm" di classifier (termasuk
    // `npm ci` sejak Fase 9), jadi jalur ini hanya ditempuh sesudah
    // persetujuan pengguna di loop — kecuali --yolo, sesuai kebijakan
    // --yolo yang sudah didokumentasikan. Perintah lain tidak berubah:
    // sandbox bila nyala, execShell biasa bila BIKININ_SANDBOX=off.
    const isInstall = isInstallCommand(a.command);
    const r = isInstall
      ? await execShell(
          a.command,
          ctx.workspace,
          INSTALL_TIMEOUT_MS,
          INSTALL_MAX_BUFFER,
          ctx.signal,
        )
      : sandboxEnabled()
        ? await execSandboxed(a.command, ctx.workspace, ctx.signal)
        : await execShell(a.command, ctx.workspace, undefined, undefined, ctx.signal);
    // Stop ditekan selagi perintah jalan: laporkan sebagai dihentikan,
    // bukan sebagai timeout/gagal biasa.
    if (ctx.signal?.aborted)
      return { ok: false, summary: "dihentikan pengguna", output: r.output, changes: [] };
    const summary = r.killed
      ? `timeout (${isInstall ? 300 : 120} dtk)`
      : r.ok
        ? "selesai (exit 0)"
        : `gagal (exit ${r.code})`;
    return { ok: r.ok, summary, output: r.output, changes: [] };
  },
});
