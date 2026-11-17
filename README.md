# Bikinin-Ai

AI agent pribadi: menulis kode, membuat website, dan video Remotion dari perintah teks. Pakai LLM lewat API berformat OpenAI. Spesifikasi lengkap ada di `AGENTS.md`.

## Coba dari HP (GitHub Codespaces, sekali-klik)

1. Di GitHub, buka repo ini → **Code → Codespaces → Create codespace on main**. Tunggu sampai selesai (Node 20 + ffmpeg terpasang otomatis, `npm ci` jalan sendiri).
2. Di terminal Codespace, jalankan: `npm run serve`
3. Buka tab **Ports**, pastikan visibilitas port **3000** = **Private**, lalu klik port 3000 untuk membuka UI Bikinin AI.
4. Hentikan Codespace saat tidak dipakai (kuota free: 120 core-hour/bulan). Di pengaturan GitHub, set spending limit Codespaces ke **$0**.

## Supaya agent bisa jalan sungguhan

UI bisa dibuka tanpa `.env`, tapi run agent butuh kunci LLM. Isi file `.env` dari `.env.example` (jangan pernah commit `.env`), atau simpan sebagai **Codespaces secrets**:

- `LLM_BASE_URL`, `LLM_API_KEY`, `BIKININ_MODEL` — penyedia utama.
- Atau `OPENROUTER_API_KEY` / `NANOGPT_API_KEY` untuk fallback multi-provider (lihat `BIKININ_PROVIDERS` di `.env.example`).

## Perintah

- `npm run serve` — jalankan web UI (port 3000)
- `npm run cli` — jalankan agent dari terminal
- `npm test` — jalankan test
- `npm run typecheck` — cek tipe TypeScript

### CLI

```
npm run cli -- "buatkan landing page kedai kopi" [--json] [--yolo]
npm run cli -- --continue [s_xxxxxxxx] "lanjutkan" [--json] [--yolo]
```

- `--json` — cetak kejadian sebagai NDJSON (satu baris per kejadian) ke stdout.
- `--continue [s_xxxxxxxx]` — lanjutkan sesi lama; tanpa id, sesi terbaru yang
  dilanjutkan. Riwayat dibaca dari log kejadian sesi
  (`<workspace>/.bikinin/sessions/<id>.jsonl`), jadi tetap bisa dilanjutkan
  walau server/CLI sudah restart.
- `--yolo` — setujui semua perintah di luar allowlist tanpa bertanya. Hanya
  bila flag ini dipakai eksplisit; perintah yang diblokir kebijakan
  (`rm -rf /`, `sudo`, `git`, dsb.) tetap diblokir.

### Log sesi dan ringkasan konteks

- Setiap kejadian run (CLI maupun web UI) ditulis ke
  `<workspace>/.bikinin/sessions/<session_id>.jsonl` (NDJSON, satu kejadian
  per baris). Nilai yang mirip rahasia (API key, token) diganti `[rahasia]`
  sebelum ditulis.
- Riwayat sesi tersimpan juga sebagai `<session_id>.json` di folder yang sama
  (dipulihkan saat server start).
- Saat riwayat mendekati batas (60.000 dari 80.000 karakter), run lama
  diganti satu ringkasan deterministik (permintaan, file yang diubah,
  keputusan) — bukan dibuang begitu saja. Tidak ada panggilan LLM tambahan
  untuk ringkasan ini.

### Skill

- Agent membaca daftar skill dari `skills/*/SKILL.md` (format: `AGENTS.md`
  Lampiran C). System prompt hanya memuat nama + deskripsi tiap skill;
  isi lengkap dibaca agent lewat tool `read_skill` sebelum mengerjakan
  tugas yang cocok.
- Skill yang ada: `website` — membuat/memperbaiki website (struktur,
  desain berkarakter, responsif, aksesibel, cara menguji); `remotion` —
  membuat video/animasi dengan Remotion (komposisi, animasi berbasis frame,
  render via CLI, batas performa).
- Menambah skill baru = membuat folder baru `skills/<nama>/SKILL.md`
  dengan frontmatter `name` (harus sama dengan nama folder) dan
  `description` (kapan skill dipakai). Tanpa mengubah kode inti.
  Daftar skill terlihat di UI dan di `GET /api/skills`.

### Video (Remotion)

- Perintah contoh: `buat video 10 detik intro dengan teks animasi`.
- Agent membaca skill `remotion` dulu, menulis project video di folder kerja
  (bukan di repo ini), lalu render lewat tool `render_video`.
- Instalasi: Remotion adalah dependensi **project video** (bukan dependensi
  Bikinin-Ai). Agent memasang `remotion@4.0.544` + `@remotion/cli@4.0.544` +
  `react`/`react-dom` di folder project (`npx create-video --blank` atau
  `npm install ...` — perintah install butuh persetujuan pemilik karena di
  luar allowlist). Tool memakai `node_modules/.bin/remotion` project kalau
  ada; kalau tidak ada, memakai `npx --yes remotion@4.0.544` (unduh saat itu
  juga, lebih lambat).
- Render pertama tiap project mengunduh browser headless Remotion
  (chrome-headless-shell, ~243 MB) ke `node_modules/.remotion/`.
  Jangan bekerja di `/tmp` (partisi kecil, 512 MB).
- Batas yang ditegakkan `render_video`: durasi maks `BIKININ_MAX_VIDEO_SECONDS`
  (default 30 detik), resolusi maks 1280×720. Still frame selalu dicek dan
  diverifikasi dulu sebelum render penuh; MP4 hasil render diverifikasi
  dengan `ffprobe` (video stream + durasi).
- Bukti smoke (`npx tsx scripts/smoke-remotion.ts`): intro 10 detik →
  MP4 h264 1280×720, durasi 10,00 dtk, ~60 KB, still PNG 23,8 KB dicek dulu.
