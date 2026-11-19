---
name: codebase-maintenance
description: Gunakan saat pengguna meminta fitur, perbaikan bug, refactor kecil, atau perubahan pada repository kode yang sudah ada.
---

# Codebase Maintenance

## Prinsip

- Pahami pola dan batasan repository sebelum mengubah file.
- Buat perubahan terkecil yang benar-benar menyelesaikan permintaan.
- Jangan menghapus atau menimpa perubahan lokal pengguna.
- Jangan mengklaim test/build berhasil sebelum menjalankannya.

## Alur kerja

1. Periksa status Git dan instruksi proyek yang relevan.
2. Ikuti alur data dari entry point sampai perilaku yang diminta; cari helper atau pola yang sudah ada.
3. Sebelum mengedit, baca file terkait dan call site langsungnya.
4. Implementasikan perubahan minimal dengan tipe dan error handling yang sesuai.
5. Tambahkan test terarah untuk perilaku baru atau bug yang diperbaiki.
6. Jalankan test/typecheck/lint terkecil yang mencakup perubahan, lalu tinjau diff.
7. Ringkas file yang berubah, hasil validasi, serta kekurangan yang masih ada.

## Batas

- Jangan mengganti framework, menambah dependensi, atau mengubah struktur besar tanpa izin.
- Jangan menyembunyikan error dengan default sukses, catch kosong, atau cast tipe yang tidak perlu.
- Jangan melakukan commit, push, deploy, atau migrasi data kecuali diminta eksplisit.
