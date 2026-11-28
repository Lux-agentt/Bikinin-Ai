---
name: bug-bounty-reporting
category: bounty
description: Gunakan saat menyusun atau memperbaiki laporan bug bounty yang sudah ditemukan dan diverifikasi dalam scope program yang mengizinkan.
---
# Bug Bounty Reporting

## Prasyarat

- Pastikan temuan berasal dari aset dan metode yang diizinkan program.
- Jangan membuat klaim dampak yang tidak didukung bukti.
- Jika reproduksi berisiko, memerlukan akses data pihak lain, atau dapat mengubah layanan, jangan mengulanginya; jelaskan keterbatasan bukti.

## Struktur laporan

1. Judul singkat: kelas masalah + komponen terdampak, tanpa klaim berlebihan.
2. Ringkasan: kondisi, aktor yang terdampak, dan dampak yang dapat dibuktikan.
3. Aset, prasyarat, dan batas scope yang relevan.
4. Langkah reproduksi minimal menggunakan akun/data uji yang sah.
5. Hasil aktual dibanding hasil yang diharapkan.
6. Bukti yang sudah disamarkan dan versi/tanggal pengujian.
7. Mitigasi yang disarankan, jika jelas dan relevan.

## Pemeriksaan sebelum kirim

- Langkah dapat diikuti reviewer, tetapi tidak memperluas akses atau mengungkap data.
- Hapus token, cookie, kredensial, alamat pribadi, data pengguna, dan rahasia lain dari bukti.
- Hindari duplikasi: bandingkan dengan aturan dan laporan terdahulu yang tersedia.
- Nyatakan asumsi, batas reproduksi, serta bagian yang belum diverifikasi.
- Jangan mengirim laporan atau menghubungi program atas nama pemilik tanpa persetujuan eksplisit.
