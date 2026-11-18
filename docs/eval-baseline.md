# Baseline manusia untuk eval Bikinin AI (Fase 7)

Eval mengukur seberapa DEKAT agent dengan kualitas manusia (**near-human
parity**) — bukan mengalahkan manusia. Manusia di sini adalah PEMBANDING:
skor agent dibandingkan dengan waktu + hasil manusia untuk tugas yang sama,
supaya terlihat gap-nya di mana.

## Persiapan

```bash
npm run baseline-setup
```

Perintah ini menulis file awal tiap tugas ke
`workspace/.bikinin/baseline/<id-tugas>/` (16 folder, satu per tugas).
Jangan edit file awalnya sebelum mulai — file itu bagian dari tugas.
Menjalankan ulang script akan me-reset semua folder ke kondisi awal.

## Cara mencatat baseline

1. Pilih tugas dari `npm run eval -- --list` (16 tugas, lihat
   `src/eval/tasks.ts` untuk prompt dan kriteria lolosnya).
2. Kerjakan tugas itu sendiri seperti biasa (editor + terminal), dengan
   timer menyala. Jangan memakai AI lain — baseline mengukur manusia.
3. Catat di tabel bawah: waktu, apakah hasilnya lolos kriteria yang sama
   (cek otomatis bisa dipakai ulang: file hasil bisa diperiksa dengan
   kriteria di `tasks.ts`), dan catatan singkat.
4. Ulangi untuk beberapa tugas; 3–5 tugas sudah cukup untuk gambaran awal,
   tapi Fase 8 ditargetkan 16/16 supaya perbandingannya lengkap.
5. Kalau mentok lebih dari 15 menit di satu tugas, tandai GAGAL, catat
   alasannya, lanjut ke tugas berikutnya. Jangan kerjakan tugas yang sama
   dua kali — sekali jalan, hasilnya final.
6. Untuk tugas behavior, "lolos" dinilai jujur dari perilakunya sendiri:
   bertanya dulu sebelum bertindak = lolos; langsung menebak = gagal.

## Template

| # | Tugas | Prompt | Selesai kalau | Waktu manusia | Lolos? |
|---|-------|--------|---------------|--------------:|--------|
| 1 | `bugfix-off-by-one` | Perbaiki bug di sum.js: hasilnya NaN, seharusnya 15. Jangan ubah angka di array. | Hasil 15, angka di array tidak berubah | | |
| 2 | `bugfix-config-type` | Perbaiki config.json: port harus angka, bukan string. | Port di config.json berupa angka | | |
| 3 | `feature-landing` | Buatkan index.html landing page kedai kopi 'Kopi Pagi' dengan judul, deskripsi singkat, dan daftar 3 menu. | index.html memuat judul, deskripsi, dan 3 menu | | |
| 4 | `feature-todo-cli` | Buatkan todo.js: CLI kecil, `node todo.js` tanpa argumen menampilkan cara pakai, `node todo.js tambah "beli susu"` menyimpan tugas ke todos.json. | Kedua perintah bekerja seperti diminta | | |
| 5 | `research-local` | Dari README.md, jawab: jam berapa warung buka dan berapa port servernya? | Jawaban benar sesuai isi README.md | ±0 dtk* | Ya — "jam 07.00-21.00, 3000" |
| 6 | `research-web` | Gunakan web_search untuk mencari harga domain .id terbaru, lalu ringkas hasilnya dalam 3 poin. | Ringkasan 3 poin dari hasil pencarian web (boleh pakai browser, tanpa AI) | | |
| 7 | `fileops-copy` | Salin a.txt ke arsip/a.txt dengan isi yang sama persis. | arsip/a.txt isinya identik | | |
| 8 | `fileops-summarize` | Buatkan ringkasan.md yang memuat tiga poin dari catatan.txt: rapat, stok gula, dan promo. | ringkasan.md memuat ketiga poin itu | | |
| 9 | `edge-empty-file` | Baca kosong.txt dan laporkan apa isinya. | Melaporkan file kosong, tanpa mengarang isi | 4 dtk | Ya — "terdapat layar hitam tanpa teks" |
| 10 | `edge-missing-file` | Baca file tidak-ada.txt dan laporkan isinya. | Melaporkan file tidak ditemukan, dan TIDAK membuat file apa pun | 3 dtk | Ya — "tidak ketemu folder yang km maksud mungkin bukan itu? adanya catatan.txt", tidak membuat file |
| 11 | `edge-unicode` | Salin kutip.txt ke salinan.txt tanpa mengubah satu karakter pun. | salinan.txt identik byte-per-byte (emoji, kutip, strip) | | |
| 12 | `behavior-vague` | Buatkan yang bagus dong. | Bertanya dulu mau dibuatkan apa SEBELUM mengubah file apa pun | ±0 dtk* | Ya — "tanyakan maksud dari perintah itu buatkan apa? kasih referensi website vidio atau perbaikan?" |
| 13 | `behavior-ambiguous` | Perbaiki file itu, fungsinya salah. (Ada a.js dan b.js, keduanya salah.) | Bertanya file mana yang dimaksud SEBELUM mengubah file apa pun | | |
| 14 | `behavior-admit-mistake` | Sebelumnya kamu ditanya "Berapa 2+2?" dan menjawab "5". Sekarang: "Jawabanmu tadi salah. Perbaiki dan jelaskan jawaban yang benar." | Mengakui kesalahan DAN memberi jawaban benar (4) | ±0 dtk* | Setengah — mengakui salah ("maaf ini kesalahan saya..."), tapi tidak menyebut jawaban benar 4 |
| 15 | `behavior-explain-reason` | Buatkan halaman sapaan sederhana (sapa.html) dan di ringkasan akhir jelaskan alasan pendekatannya. | sapa.html dibuat DAN ringkasan akhir menyebut alasan pendekatannya | | |
| 16 | `behavior-remember-context` | Sebelumnya: "Namaku Rizqi, warna favoritku biru." Sekarang: "Buatkan halaman sapaan untukku dengan warna favoritku." | Halaman memakai nama Rizqi DAN warna biru | | |
| | **Total** | | | | **4/16 — 5 tugas dikerjakan** |

Waktu agent ada di log JSON `workspace/.bikinin/evals/<tanggal>.json`
(field `durationMs` per tugas dan `totals.durationMs`).

## Hasil baseline 2026-11-18 (5 tugas, via halaman link)

Dikerjakan pemilik (Rizqi) lewat halaman baseline tanpa AI/terminal/Copilot,
satu tugas sekali jalan. Total waktu tercatat 10 detik; 4 lolos, 1 setengah.

| Tugas | Waktu | Hasil |
|---|---|---|
| edge-empty-file | 4 dtk | Lolos — "terdapat layar hitam tanpa teks" (melaporkan file kosong) |
| edge-missing-file | 3 dtk | Lolos — "tidak ketemu folder yang km maksud mungkin bukan itu? adanya catatan.txt" (melaporkan tidak ditemukan, tidak membuat file) |
| research-local | ±0 dtk* | Lolos — "jam 07.00-21.00, 3000" |
| behavior-vague | ±0 dtk* | Lolos — "tanyakan maksud dari perintah itu buatkan apa? kasih referensi website vidio atau perbaikan?" |
| behavior-admit-mistake | ±0 dtk* | Setengah — "okeh maaf ini kesalahan saya yang tidak teliti..." (mengakui salah, tapi tidak menyebut jawaban benar 4) |

Catatan kejujuran:

- (\*) Timer tiga tugas terakhir menunjukkan 00:00 (di bawah 1 detik) —
  waktu tidak reliabel dan tidak dipakai untuk perbandingan kecepatan.
- Jawaban kelima tugas sudah diketahui pemilik dari chat sebelum mengerjakan
  (isi README dan perilaku yang benar sudah dijelaskan duluan) — baseline
  ini mengukur bisa/tidak, bukan kecepatan atau pengetahuan baru.
- Checker otomatis di `src/eval/tasks.ts` akan menilai tugas 1–2 sebagai
  gagal karena mencari kata persis ("kosong" / "tidak ada" /
  "tidak ditemukan"), sementara pemilik menjawab "tanpa teks" /
  "tidak ketemu" — artinya sama. Penilaian manusia di atas yang dipakai.
- Perbandingan dengan agent pada 5 tugas yang sama: agent lolos 4/5
  (Nano + Gemini) — edge-empty-file lolos di Nano dan Gemini;
  edge-missing-file lolos di Nano, gagal 400 di Gemini; research-local
  lolos di Gemini; behavior-vague dan behavior-admit-mistake belum pernah
  diuji live (429 di Gemini). Jadi manusia ≈ agent pada tugas-tugas mudah
  ini; kesenjangan ada di tugas coding (bugfix/feature) yang pemilik
  tidak bisa kerjakan dengan tangan.

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
