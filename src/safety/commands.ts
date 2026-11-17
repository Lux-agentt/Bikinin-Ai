// Command policy for run_command: block destructive patterns, allow a small allowlist,
// ask the user for everything else. Enforced in code, not only in the prompt.
export type Risk = "low" | "medium" | "high";

export type Verdict =
  | { decision: "allow" }
  | { decision: "confirm"; reason: string; risk: Risk; command: string }
  | { decision: "block"; reason: string; command: string };

const BLOCKED: Array<{ re: RegExp; reason: string }> = [
  {
    re: /\brm\s+(-\S+\s+)*(\/|~|\$HOME|\$\{HOME\})(\s|\/\*|$)/,
    reason: "rm pada root atau home",
  },
  {
    // rm yang targetnya isi workspace sendiri (., ./, *, ./*, termasuk
    // sebagai target kedua). Sebelumnya hanya "confirm" — di --yolo jalan
    // tanpa bertanya dan menghapus isi workspace termasuk log sesi.
    // Target bernama (mis. node_modules) tetap "confirm", bukan block.
    re: /\brm\b[^;&|]*[\s](\.|\*|\.\/|\.\/\*)([\s;&|]|$)/,
    reason: "rm menghapus isi workspace (., ./, *)",
  },
  {
    // ".." sebagai segmen path di mana saja: diawali / . " ' ; | & < > =
    // dsb. (bukan hanya awal-string/spasi) dan diikuti / ; | & spasi, kutip,
    // atau akhir string. "a..b" dan "..hidden" bukan traversal karena ".."
    // menempel huruf — tidak tertangkap.
    re: /(^|[^A-Za-z0-9_.-])\.\.([^A-Za-z0-9_.-]|$)/,
    reason: "akses folder induk (..)",
  },
  {
    // "/" absolut dikenali juga sesudah kutip, <, =, (, koma, ;, &.
    // Pengecualian /dev/null diperketat: /dev/nullx tetap diblokir.
    // ":" sengaja bukan awalan — URL https://... tetap lolos ke confirm.
    re: /(^|[\s>|"'=<\(,;&])\/(?!dev\/null(?=$|[\s"'\/;&|]))/,
    reason: "path absolut di luar workspace",
  },
  {
    re: /(^|[\s>|"'=<\(])~/,
    reason: "path home (~) tidak diizinkan",
  },
  { re: /\$HOME|\$\{HOME\}/, reason: "referensi $HOME tidak diizinkan" },
  {
    // $VAR kosong -> "/...", ${IFS} -> spasi -> "/...", dan ${X:-/...}.
    // Di shell baru tiap run_command, $VAR hanya bisa kosong atau berasal
    // dari env server — jadi $VAR/... praktis selalu jadi path absolut.
    re: /\$[A-Za-z_][A-Za-z0-9_]*(?=\/)|\$\{[A-Za-z_][A-Za-z0-9_]*\}(?=\/)|\$\{[^}]*\//,
    reason: "ekspansi variabel menjadi path ($VAR/...) tidak diizinkan",
  },
  {
    // Assignment inline di string perintah melewati safeEnv (yang hanya
    // membersihkan env warisan): VAR=nilai cmd, atau export VAR=nilai.
    // PATH dan HOME sengaja ikut di sini (bukan di safeEnv): yang diwariskan
    // dari env server operator boleh, yang ditulis model di perintah tidak.
    re: /(^|[;&|\s])(LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_COMMON_DIR|GIT_CONFIG|GIT_CONFIG_COUNT|GIT_CONFIG_PARAMETERS|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_SSH|GIT_SSH_COMMAND|GIT_ASKPASS|GIT_EDITOR|GIT_PAGER|GIT_CEILING_DIRECTORIES|CDPATH|IFS|ENV|BASH_ENV|PATH|HOME|NPM_CONFIG_[A-Z0-9_]+)=/,
    reason: "assignment variabel pengubah perilaku di perintah",
  },
  { re: /\bsudo\b/, reason: "sudo tidak diizinkan" },
  {
    // Perintah jalan via /bin/sh -c, jadi substitusi perintah mengeksekusi
    // apa pun di dalamnya tanpa lewat classifier (mis. echo $(rm -rf /)).
    re: /\$\(/,
    reason: "substitusi perintah $(...) tidak diizinkan",
  },
  {
    re: /`/,
    reason: "backtick (substitusi perintah) tidak diizinkan",
  },
  {
    // Hanya saat env/printenv menjadi perintahnya (awal perintah atau
    // sesudah pemisah && ; |) — "grep env file" tetap boleh.
    re: /(^|[;&|]\s*)(env|printenv)(\s|$)/,
    reason: "env/printenv tidak diizinkan",
  },
  {
    re: /(^|[\s;&|])(git|gh|ssh|scp|rsync)(\s|$)/,
    reason: "git/gh/ssh tidak diizinkan dari agent",
  },
  { re: /\bnpm\s+publish\b/, reason: "npm publish tidak diizinkan" },
  { re: /\bmkfs/, reason: "format disk" },
  { re: /\bdd\s+if=/, reason: "dd tidak diizinkan" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, reason: "perintah sistem" },
  {
    re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/,
    reason: "pipe unduhan ke shell",
  },
  { re: /:\(\)\s*\{/, reason: "fork bomb" },
];

// Each shell segment (split on && || ; | newline) must match one of these to run without asking.
const ALLOWED: RegExp[] = [
  /^npm (run [\w:.-]+|test|ci|--version|-v)$/,
  /^npx (tsc|vitest|tsx|prettier)( .*)?$/,
  /^tsc( .*)?$/,
  /^node [\w./-]+\.(m?js|ts)$/,
  /^(ls|pwd|cat|head|tail|wc|grep|echo|mkdir)( .*)?$/,
];

export function classifyCommand(command: string): Verdict {
  const cmd = command.trim();
  if (cmd === "")
    return { decision: "block", reason: "perintah kosong", command };

  for (const rule of BLOCKED) {
    if (rule.re.test(cmd))
      return { decision: "block", reason: rule.reason, command };
  }

  const segments = cmd
    .split(/&&|\|\||;|\||\n/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const allSafe = segments.every((seg) => ALLOWED.some((re) => re.test(seg)));
  if (allSafe) return { decision: "allow" };

  return {
    decision: "confirm",
    reason: "perintah di luar allowlist",
    risk: "medium",
    command,
  };
}
