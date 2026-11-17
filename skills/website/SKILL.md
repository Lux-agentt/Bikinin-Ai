---
name: website
description: Gunakan saat pengguna ingin membuat website, landing page, atau halaman web baru, atau memperbaiki tampilan dan struktur website yang sudah ada.
---

# Website

Skill ini dipakai setiap kali tugasnya membuat atau mengubah website.
Baca skill ini sampai habis SEBELUM menulis file pertama.

## Kapan dipakai
- Membuat website, landing page, atau halaman web baru dari nol.
- Mengubah layout, warna, tipografi, atau struktur halaman yang sudah ada.
- Memperbaiki tampilan yang rusak di HP atau di layar besar.

## Alur kerja
1. Pahami dulu siapa pengunjungnya dan apa SATU aksi yang diharapkan dari mereka (mis. daftar, baca, hubungi, beli). Tulis itu dalam satu kalimat di rencana.
2. Tentukan struktur halaman: hero → isi utama → penutup (CTA). Satu halaman = satu topik.
3. Tulis HTML dulu (struktur + teks asli), lalu CSS (tampilan), lalu JS (interaksi) hanya bila perlu.
4. Uji seperti di bagian "Cara menguji" di bawah. Jangan menyatakan selesai sebelum diuji.

## Struktur project
- Satu halaman sederhana: `index.html` + `app.css` + `app.js` (boleh tanpa JS kalau tidak ada interaksi).
- Beberapa halaman: satu folder per halaman atau satu `index.html` per rute, aset bersama di `assets/` (gambar, font).
- Jangan pakai build step (bundler, framework) kecuali pengguna memintanya atau halaman butuh komponen yang berulang lebih dari 3 kali.
- File yang dihasilkan agent harus bisa dibuka langsung di browser tanpa server khusus, kecuali memang butuh backend.

## Desain yang punya karakter
- Pilih palet, tipografi, dan layout yang cocok dengan KONTEKS, bukan template generik. Contoh acuan yang sudah dipakai repo ini: latar gelap `#05060b`, teks terang, satu warna aksen gradasi, font UI Inter + font serif untuk judul.
- Satu aksen saja. Kalau semua warna berteriak, tidak ada yang menonjol.
- Judul harus bilang apa yang didapat pengunjung, bukan nama produk semata. Contoh: "Apa yang kita bikin hari ini" lebih jelas daripada "Selamat datang".
- Teks isi harus realistis dan spesifik (nama, angka, contoh nyata). Dilarang lorem ipsum dan teks contoh seperti "Lorem", "Judul di sini", "Deskripsi produk".
- Jarak dan ukuran konsisten: satu skala spasi (mis. 8/16/24/32px) dan maksimal 3 ukuran judul.
- Gambar: pakai yang relevan; kalau tidak ada gambar, pakai warna, bentuk, dan tipografi — jangan pasang gambar asal-asalan.

## Responsif
- Mobile dulu: tulis CSS untuk layar kecil, lalu tambah aturan untuk layar besar (`min-width: 768px`, `min-width: 1080px`).
- Wajib ada `<meta name="viewport" content="width=device-width, initial-scale=1">`.
- Target sentuh minimal 44px; tombol utama mudah dijangkau satu tangan di HP.
- Teks tidak boleh terpotong dan tidak boleh memaksa scroll horizontal di lebar 360px.
- Gambar dan video: `max-width: 100%`, sertakan `width`/`height` atau `aspect-ratio` supaya layout tidak lompat saat dimuat.

## Aksesibel
- HTML semantik: `header`, `main`, `footer`, `nav`, `h1` sekali per halaman lalu `h2`/`h3` berurutan.
- Semua gambar bermakna punya `alt`; gambar dekoratif pakai `alt=""`.
- Semua input punya `label` yang terlihat atau `aria-label`.
- Kontras teks minimal 4.5:1 untuk teks biasa. Jangan hanya mengandalkan warna untuk menyampaikan informasi (mis. error harus ada teks, bukan cuma warna merah).
- Fokus keyboard harus terlihat (`:focus-visible`) dan semua aksi bisa dilakukan tanpa mouse.
- Jangan mematikan zoom dan jangan memakai teks di bawah 12px untuk isi utama.

## Cara menguji
- Buka halaman di lebar 360px, 768px, dan 1280px. Cek: tidak ada scroll horizontal, tidak ada teks terpotong, tombol tetap bisa diklik.
- Klik semua link dan tombol; tidak boleh ada yang mati atau mengarah ke `#`.
- Buka console browser: tidak boleh ada error.
- Coba navigasi hanya dengan keyboard (Tab/Enter). Semua aksi harus tercapai.
- Baca semua teks sekali lagi: tidak ada lorem ipsum, tidak ada placeholder, ejaan benar.

## Kesalahan umum
- Membuat halaman yang terlihat seperti template: hero generik + 3 kartu fitur + footer. Kalau bisa dipakai untuk produk apa pun, desainnya belum punya karakter.
- Menambah animasi berat sebelum kontennya benar. Konten dulu, hiasan belakangan.
- Mengabaikan HP: menguji hanya di layar besar lalu menganggap selesai.
- Menulis teks contoh dan berencana "nanti diganti" — teks contoh yang tertinggal adalah bug.
