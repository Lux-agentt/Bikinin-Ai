// Sandbox hardening (Fase 7, Track D): regression tests for the command
// classifier gaps found by the read-only audit, plus the safeEnv denylist.
//
// Every exploit string below is a literal passed ONLY to the pure function
// classifyCommand / safeEnv — nothing here is ever executed in a shell.
// The point of each test is the verdict: "block" (or the variable dropped),
// never "allow"/"confirm" for an escape.
import { describe, expect, it } from "vitest";
import { classifyCommand } from "../src/safety/commands.js";
import { safeEnv } from "../src/tools/run-command.js";

const BLOCKED_COMMANDS: Array<[string, string]> = [
  // Temuan 1 — ".." sebagai segmen path lolos dari aturan lama:
  // aturan lama hanya mengenal ".." yang diawali awal-string/spasi.
  ["cat ./../secret", "temu 1: .. diawali /"],
  ["cat a/../../x", "temu 1: .. di tengah path"],
  ["cat foo/../bar", "temu 1: .. naik satu level"],
  ["cd ..; pwd", "temu 1: cd .. keluar dari cwd jail"],
  ["cd ../..; pwd", "temu 1: cd dua level"],
  ["cd ./..; pwd", "temu 1: cd ./.."],
  ["pushd ..", "temu 1: pushd .."],
  // Temuan 2 — path absolut dalam tanda kutip lolos dari aturan lama:
  // aturan lama hanya mengenal spasi/>/| sebagai awalan "/".
  ['cat "/etc/passwd"', "temu 2: absolut dalam kutip ganda"],
  ["cat '/etc/passwd'", "temu 2: absolut dalam kutip tunggal"],
  ['head -n 5 "/etc/shadow"', "temu 2: absolut dikutip, perintah lain"],
  // Temuan 3 — redirect "<" lolos dari aturan absolut lama.
  ["cat</etc/passwd", "temu 3: redirect < tanpa spasi"],
  ["head -c 10</etc/passwd", "temu 3: redirect < tanpa spasi, head"],
  ["cat <../secret", "temu 3: redirect < ke .."],
  // Temuan 4 — ekspansi variabel menjadi path absolut.
  // $VAR kosong -> "/etc/passwd"; ${IFS} -> spasi -> "/etc/passwd".
  ["cat $VAR/etc/passwd", "temu 4: $VAR kosong jadi /"],
  ["cat ${IFS}/etc/passwd", "temu 4: ${IFS} jadi spasi"],
  ["cat ${X:-/etc/passwd}", "temu 4: default-value expansion berisi /"],
  ["cat $IFS/etc/passwd", "temu 4: $IFS jadi spasi"],
  // Temuan 5 — rm penghapus workspace: aturan lama hanya menutup /, ~, $HOME.
  // Di --yolo, "confirm" = jalan tanpa bertanya dan menghapus isi workspace
  // termasuk log sesi.
  ["rm -rf ./", "temu 5: rm ./"],
  ["rm -rf .", "temu 5: rm ."],
  ["rm -rf *", "temu 5: rm *"],
  ["rm -rf ./*", "temu 5: rm ./*"],
  ["rm -rf foo *", "temu 5: rm * sebagai target kedua"],
  // Celah sekeluarga temuan 6 — assignment inline di string perintah
  // melewati safeEnv sepenuhnya (safeEnv hanya membersihkan env warisan).
  ["LD_PRELOAD=/tmp/x.so node app.js", "temu 6b: LD_PRELOAD inline"],
  ["NODE_OPTIONS=--require /tmp/x.js npm test", "temu 6b: NODE_OPTIONS inline"],
  ["GIT_DIR=/tmp/x.git npm test", "temu 6b: GIT_DIR inline"],
  ["export NODE_OPTIONS=--require /tmp/x.js; npm test", "temu 6b: export NODE_OPTIONS"],
  ["CDPATH=/tmp; ls", "temu 6b: CDPATH inline"],
  // PATH/HOME inline juga diblokir (berbeda dengan yang diwariskan dari env
  // server — lihat safeEnv): yang ditulis model di perintah tidak boleh
  // mengalihkan pencarian binary/config.
  ["PATH=/tmp/evil npm test", "temu 6b: PATH inline"],
  ["HOME=/tmp/fake npm test", "temu 6b: HOME inline"],
  // Varian terkait yang harus tetap diblokir.
  ["cat ../secret", "regresi: .. klasik"],
  ["cat /etc/passwd", "regresi: absolut klasik"],
  ["rm -rf /", "regresi: rm /"],
  ["rm -rf ~", "regresi: rm ~"],
  ['cat "~/x"', "regresi: ~ dalam kutip"],
  ["cat $HOME/x", "regresi: $HOME"],
];

describe("sandbox: celah classifier harus block", () => {
  it.each(BLOCKED_COMMANDS)("blocks %s (%s)", (cmd) => {
    expect(classifyCommand(cmd).decision).toBe("block");
  });
});

describe("sandbox: perintah sah tetap jalan", () => {
  it.each([
    "npm run build",
    "npm test",
    "npx tsc --noEmit",
    "npx vitest run tests/sandbox.test.ts",
    "ls -la",
    "cat index.html",
    "cat .env",
    "grep env file.txt",
    "grep -r TODO src/",
    "echo hello world",
    "mkdir -p dist/assets",
    "node build.mjs",
    "cat file.txt | head -n 5",
    "cat /dev/null",
    "echo hi > /dev/null",
    // ".." yang menempel huruf bukan traversal.
    "cat ..hidden",
    "cat a..b",
  ])("allows %s", (cmd) => {
    expect(classifyCommand(cmd).decision).toBe("allow");
  });

  it.each([
    "npm install",
    // Hapus folder bernama di dalam workspace tetap butuh konfirmasi,
    // bukan block — kebijakan lama yang dipertahankan.
    "rm -rf node_modules",
    "rm -rf ./node_modules",
    "rm -rf *.log",
    "curl https://example.test",
  ])("asks for confirmation on %s", (cmd) => {
    expect(classifyCommand(cmd).decision).toBe("confirm");
  });
});

describe("sandbox: safeEnv membuang variabel pengubah perilaku", () => {
  const hostile: NodeJS.ProcessEnv = {
    // HOME dan PATH sengaja TIDAK ada di daftar buang: keduanya berasal dari
    // env server operator (trust domain yang sama dengan proses server itu
    // sendiri — anak proses tidak bisa mengubah env server), dan membuangnya
    // merusak npm/node (PATH berisi lokasi node, mis. nvm; HOME dipakai npm
    // dan git untuk cache/konfigurasi). Lihat docs/sandbox-limits.md.
    HOME: "/home/operator",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    // Temuan 6 — diteruskan sebelum perbaikan.
    LD_PRELOAD: "/tmp/evil.so",
    LD_LIBRARY_PATH: "/tmp/evil",
    LD_AUDIT: "/tmp/evil.so",
    DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
    NODE_OPTIONS: "--require /tmp/evil.js",
    NODE_PATH: "/tmp/evil",
    NODE_EXTRA_CA_CERTS: "/tmp/fake-ca.pem",
    GIT_DIR: "/tmp/evil.git",
    GIT_WORK_TREE: "/etc",
    GIT_INDEX_FILE: "/tmp/evil-index",
    GIT_OBJECT_DIRECTORY: "/tmp/evil-obj",
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "/tmp/evil-alt",
    GIT_CONFIG: "/tmp/evil-config",
    GIT_CONFIG_COUNT: "1",
    GIT_SSH_COMMAND: "ssh -oProxyCommand=evil",
    CDPATH: "/tmp",
    IFS: "/",
    ENV: "/tmp/evil.sh",
    BASH_ENV: "/tmp/evil.sh",
    NPM_CONFIG_REGISTRY: "https://evil.example/",
    // Rahasia — sudah dibuang sebelum perbaikan.
    LLM_API_KEY: "sk-test",
    MY_TOKEN: "tok-test",
    DB_PASSWORD: "pw-test",
    // Variabel jinak — harus tetap diteruskan.
    NODE_ENV: "production",
    LANG: "en_US.UTF-8",
    TZ: "Asia/Jakarta",
    TERM: "xterm-256color",
  };

  it("drops behaviour-changing variables and secrets", () => {
    const out = safeEnv(hostile);
    for (const name of [
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "LD_AUDIT",
      "DYLD_INSERT_LIBRARIES",
      "NODE_OPTIONS",
      "NODE_PATH",
      "NODE_EXTRA_CA_CERTS",
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_CONFIG",
      "GIT_CONFIG_COUNT",
      "GIT_SSH_COMMAND",
      "CDPATH",
      "IFS",
      "ENV",
      "BASH_ENV",
      "NPM_CONFIG_REGISTRY",
      "LLM_API_KEY",
      "MY_TOKEN",
      "DB_PASSWORD",
    ]) {
      expect(out, `expected ${name} to be dropped`).not.toHaveProperty(name);
    }
  });

  it("keeps benign variables", () => {
    const out = safeEnv(hostile);
    expect(out.NODE_ENV).toBe("production");
    expect(out.LANG).toBe("en_US.UTF-8");
    expect(out.TZ).toBe("Asia/Jakarta");
    expect(out.TERM).toBe("xterm-256color");
    // HOME dan PATH dipertahankan dengan sengaja (lihat komentar di atas).
    expect(out.HOME).toBe("/home/operator");
    expect(out.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
  });
});
