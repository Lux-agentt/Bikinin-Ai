// Command policy for run_command: block destructive patterns, allow the
// safe local set below, ask the user for everything else. Enforced in code,
// not only in the prompt. The allowlist is the filter the user asked for
// (2026-11-28): routine website work runs without asking; only the
// genuinely dangerous set (installs, network, destructive ops, anything
// unknown) still pops an approval sheet. Path safety is fenced by the
// BLOCKED rules above (absolute paths, .., ~, secrets) — so the commands
// below can only touch files inside the workspace, like write_file does.
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
    // File rahasia di dalam workspace (.env, kunci privat, kredensial):
    // `cat` ada di allowlist, jadi tanpa aturan ini `cat .env` jalan tanpa
    // bertanya. Aturan block diperiksa sebelum allowlist, jadi pola ini
    // menutup celah itu. ".env.example" (template tanpa rahasia) sengaja
    // tidak tertangkap lewat lookahead negatif. "x.env" ikut tertangkap —
    // itu memang file dotenv.
    re: /\.env(?!\.(example|sample|template|dist)\b)(\.[A-Za-z0-9_-]+)?($|[\s;|&"'`\/])/,
    reason: "file rahasia .env tidak boleh dibaca dari perintah",
  },
  {
    // Kunci privat / sertifikat sebagai argumen perintah (cat key.pem, dst).
    re: /\.(pem|key|p12|pfx)($|[\s;|&"'`\/])/,
    reason: "file kunci/sertifikat tidak boleh dibaca dari perintah",
  },
  {
    // Nama file kunci tanpa ekstensi (id_rsa, id_ed25519, ...) dan file
    // kredensial (credentials.json, ...).
    re: /(^|[\s;|&"'`=\/.(])(id_(rsa|ed25519|ecdsa|dsa)|credentials[\w.-]*\.(json|yaml|yml|txt))($|[\s;|&"'`\/])/,
    reason: "file kunci/kredensial tidak boleh dibaca dari perintah",
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
  {
    // curl/wget yang mengirim data atau file keluar: -d/--data* (isi POST),
    // --upload-file/-T (unggah file), --form/-F (multipart, bisa "@/path"),
    // --post-data/--post-file (wget). curl/wget polos (GET) tetap "confirm"
    // — exfiltrasi lewat network dimatikan sandbox, ini lapis tambahannya.
    re: /\b(curl|wget)\b[^;&|\n]*?(?:\s|^)(--data(-binary|-raw|-urlencode)?|-d|--upload-file|-T|--form|-F|--post-data|--post-file)(?:\s|=|$)/,
    reason: "curl/wget mengirim data/file keluar",
  },
  {
    // Netcat/socat: kanal network mentah yang tidak butuh curl.
    // Pola posisi-perintah supaya "cat nc.txt" (nama file) tidak kena.
    re: /(^|[\s;&|])(nc|netcat|ncat|socat)(\s|$)/,
    reason: "netcat/socat tidak diizinkan",
  },
  {
    // Kode inline interpreter (python -c, node -e, ...) menjalankan string
    // arbitrer tanpa jejak file di workspace — tidak bisa di-review seperti
    // skrip yang ditulis lewat write_file. Tulis dulu sebagai file, lalu
    // jalankan filenya (tetap "confirm" bila di luar allowlist).
    re: /(^|[\s;&|])(python3?|perl|ruby|php|node)\s+(-c|-e|-r|--eval)\b/,
    reason: "kode inline interpreter (-c/-e/-r) tidak diizinkan",
  },
  {
    // Shell bersarang (sh -c '...') menambah satu lapis quoting tempat pola
    // di atas bisa disembunyikan; perintah agent tidak butuh sh -c karena
    // run_command sendiri sudah jalan via /bin/sh -c.
    re: /(^|[\s;&|])(bash|sh|dash|zsh)\s+-c\b/,
    reason: "shell bersarang (sh -c) tidak diizinkan",
  },
];

// Each shell segment (split on && || ; | newline) must match one of these to run without asking.
// `npm ci` sengaja TIDAK di sini sejak Fase 9: instalasi dependensi jalan
// di luar sandbox (butuh network registry), jadi butuh persetujuan pengguna
// seperti `npm install` — sebelumnya `npm ci` berstatus allow karena di
// dalam sandbox ia tidak bisa mengambil apa pun dari network.
// `sed -i` (edit in-place) sengaja TIDAK di sini: edit file pakai edit_file.
// `python3 -m http.server` juga TIDAK: server manual menggantung tool call
// (preview sudah disediakan UI) — tetap minta izin supaya bisa ditolak.
// `find` hanya bentuk amannya: -delete/-exec/-execdir/-ok jatuh ke confirm.
// Split a shell command into segments on && || ; | newline — but a pipe
// inside quotes or escaped (\|) is part of the argument, not a separator:
// `grep -n "a\|b" file` is ONE grep call, and `grep -E '(href|src)' file`
// is ONE grep call. The naive .split() broke both into pieces that no
// longer match the allowlist, so routine greps popped an approval sheet
// and the run waited forever (live 2026-11-28: grep "tilt\|transform3d"
// stuck run_e03e3314; the user read it as "chat 1 stops when I go to
// chat 2"). BLOCKED rules still run on the whole command first, so this
// can only make the allow check more accurate, never looser.
function splitSegments(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      // Inside double quotes a backslash escapes the next char (so \"
      // does not close the quote); inside single quotes it is literal.
      if (quote === '"' && ch === "\\" && i + 1 < cmd.length) {
        cur += ch + cmd[i + 1];
        i++;
        continue;
      }
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\" && i + 1 < cmd.length) {
      cur += ch + cmd[i + 1];
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "&" && cmd[i + 1] === "&") {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (ch === "|" && cmd[i + 1] === "|") {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

const ALLOWED: RegExp[] = [
  /^npm (run [\w:.-]+( -- .*)?|test|--version|-v)$/,
  // npx hanya tool bernama yang dipakai agent sendiri (bukan paket acak —
  // npx <paket-acak> bisa download + jalanin kode apa pun, tetap confirm).
  // remotion = CLI video agent (Fase 3); render video memakainya terus.
  /^npx (tsc|vitest|tsx|prettier|remotion)( .*)?$/,
  /^tsc( .*)?$/,
  /^node (--check )?[\w./-]+\.(m?js|ts)( .*)?$/,
  /^(ls|pwd|cat|head|tail|wc|grep|echo|mkdir|date)( .*)?$/,
  /^sed -n( .*)?$/,
  /^python3? [\w./-]+\.py( .*)?$/,
  /^find (?!.*-(delete|exec|execdir|ok)(\s|$)).*$/,
  /^(cp|mv|touch|diff)( .*)?$/,
  // `cd` hanya relatif (aturan BLOCKED memagari .. dan path absolut
  // duluan); `which` hanya membaca; `true`/`false` no-op (`|| true`).
  // `sleep N` cuma menunggu; `date` cuma membaca jam.
  /^cd( [\w./-]+)?$/,
  /^which [\w./-]+( [\w./-]+)*$/,
  /^(true|false)$/,
  /^sleep \d+$/,
];

export function classifyCommand(command: string): Verdict {
  const cmd = command.trim();
  if (cmd === "")
    return { decision: "block", reason: "perintah kosong", command };

  for (const rule of BLOCKED) {
    if (rule.re.test(cmd))
      return { decision: "block", reason: rule.reason, command };
  }

  const segments = splitSegments(cmd);
  const allSafe = segments.every((seg) => ALLOWED.some((re) => re.test(seg)));
  if (allSafe) return { decision: "allow" };

  return {
    decision: "confirm",
    reason: "perintah di luar allowlist",
    risk: "medium",
    command,
  };
}
