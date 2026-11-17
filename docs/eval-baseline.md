# Baseline manusia untuk eval Bikinin AI (Fase 7)

Eval mengukur seberapa DEKAT agent dengan kualitas manusia (**near-human
parity**) — bukan mengalahkan manusia. Manusia di sini adalah PEMBANDING:
skor agent dibandingkan dengan waktu + hasil manusia untuk tugas yang sama,
supaya terlihat gap-nya di mana.

## Cara mencatat baseline

1. Pilih tugas dari `npm run eval -- --list` (16 tugas, lihat
   `src/eval/tasks.ts` untuk prompt dan kriteria lolosnya).
2. Kerjakan tugas itu sendiri seperti biasa (editor + terminal), dengan
   timer menyala. Jangan memakai AI lain — baseline mengukur manusia.
3. Catat di tabel bawah: waktu, apakah hasilnya lolos kriteria yang sama
   (cek otomatis bisa dipakai ulang: file hasil bisa diperiksa dengan
   kriteria di `tasks.ts`), dan catatan singkat.
4. Ulangi untuk beberapa tugas; 3–5 tugas sudah cukup untuk gambaran awal.

## Template

| Tugas | Waktu manusia | Lolos? | Waktu agent (dari log eval) | Catatan |
|---|---|---|---|---|
| `bugfix-off-by-one` | | | | |
| `feature-landing` | | | | |
| `research-local` | | | | |
| `behavior-vague` | | | | |
| | | | | |

Waktu agent ada di log JSON `workspace/.bikinin/evals/<tanggal>.json`
(field `durationMs` per tugas dan `totals.durationMs`).

## Cara membaca perbandingan

- **Waktu:** bandingkan menit manusia vs detik agent. Agent hampir selalu
  lebih cepat di tugas mekanis — itu bukan "menang", itu ekspektasi.
- **Kualitas perilaku:** untuk tugas `behavior-*`, bandingkan APA yang
  dilakukan manusia (bertanya dulu? mengakui salah? menjelaskan alasan?)
  dengan proxy otomatis agent di log. Proxy hanya memeriksa APAKAH itu
  terjadi; ketepatan isinya dinilai dengan membaca log event.
- **Gap yang penting:** kalau agent lebih cepat tapi gagal di tugas yang
  manusia anggap mudah (mis. pesan samar), itulah gap yang harus
  diperbaiki — bukan skor totalnya.

## Yang TIDAK dilakukan baseline ini

- Tidak ada target "agent harus mengalahkan manusia".
- Tidak ada skor gabungan manusia-vs-agent; yang dibandingkan adalah
  per-tugas, supaya kelemahan spesifik terlihat.
- Baseline cukup dicatat sekali per beberapa minggu; tidak perlu diulang
  tiap kali eval jalan.
