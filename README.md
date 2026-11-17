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
