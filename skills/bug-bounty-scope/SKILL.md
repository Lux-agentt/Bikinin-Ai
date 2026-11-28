---
name: bug-bounty-scope
category: web3-bounty
description: Gunakan sebelum riset atau pengujian keamanan terkait program bug bounty, untuk memastikan target dan metode benar-benar diizinkan.
---
# Bug Bounty Scope and Safety

## Tujuan

Membantu pemilik memahami aturan program dan menyiapkan riset yang bertanggung jawab. Skill ini bukan izin untuk menguji target.

## Sebelum aktivitas apa pun

1. Minta URL resmi program atau salinan aturan terbaru.
2. Catat aset in-scope, aset out-of-scope, jenis temuan yang diterima, larangan, batas request, dan aturan pengungkapan.
3. Pastikan program mengizinkan pengujian manual/otomatis dan bantuan AI. Jika aturan tidak jelas, jangan mengirim request ke target; minta konfirmasi pemilik atau tanyakan ke program.
4. Batasi setiap rencana pada aset yang secara eksplisit diizinkan. Subdomain yang tampak terkait bukan bukti bahwa ia in-scope.
5. Utamakan analisis kode, dokumentasi, dan bukti yang sudah tersedia. Hindari pengumpulan data pengguna.

## Batas pengujian

- Jangan menjalankan pemindaian luas, eksploitasi, brute force, denial-of-service, persistence, atau tindakan yang mengubah data.
- Jangan mengakses akun/data orang lain, melewati kontrol untuk memperoleh data, atau menguji layanan pihak ketiga yang bukan aset program.
- Gunakan akun dan data uji milik pemilik bila program mengizinkan. Hentikan segera jika ada dampak tak terduga atau data sensitif.
- Jangan melanjutkan saat ada ketidakpastian tentang otorisasi, scope, atau dampak. Laporkan pertanyaan dan tunggu arahan.

## Hasil

Buat ringkasan scope yang memuat URL sumber aturan, tanggal pemeriksaan, aset yang diizinkan, metode yang dilarang, dan ketidakpastian. Jangan menyebut target “aman diuji” jika ada syarat yang belum dipastikan.
