---
name: website-qa
description: Gunakan setelah membuat atau mengubah website untuk memeriksa fungsi, tampilan mobile, aksesibilitas dasar, dan error sebelum selesai.
---

# Website QA

Skill ini melengkapi skill `website`; jalankan setelah implementasi, bukan sebagai pengganti test proyek.

## Pemeriksaan

1. Jalankan build, test, dan lint yang tersedia; laporkan hasil sebenarnya.
2. Periksa halaman utama dan rute yang disentuh, termasuk state kosong, loading, sukses, dan error bila ada.
3. Uji lebar mobile sekitar 360 px, tablet sekitar 768 px, dan desktop sekitar 1280 px.
4. Pastikan tidak ada scroll horizontal, teks/tombol terpotong, atau kontrol yang terlalu kecil untuk disentuh.
5. Periksa heading, label input, alt gambar, focus keyboard, kontras, dan `prefers-reduced-motion`.
6. Uji link, tombol, form, navigasi, serta pesan kegagalan; jangan hanya memeriksa tampilan statis.
7. Jika browser/preview tidak tersedia, jelaskan keterbatasannya dan lakukan pemeriksaan alternatif yang memang bisa dijalankan.

## Pelaporan

Pisahkan bug yang ditemukan dari perbaikan yang sudah dilakukan. Jangan menyatakan visual QA berhasil bila halaman tidak benar-benar dibuka pada ukuran layar tersebut.
