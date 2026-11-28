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

## CSS wajib — jangan kirim halaman polos

Aturan ini MENGIKAT, bukan saran. Halaman yang dikirim tanpa CSS nyata adalah hasil yang GAGAL, seberapa pun benar isinya.

- Setiap halaman HTML penuh WAJIB memuat CSS nyata: blok `<style>` di `<head>` atau file CSS yang di-link. Jangan pernah kirim halaman yang dirender dengan tampilan default browser.
- Tampilan default browser yang DILARANG: font serif Times, link biru standar (`#0000EE`), nav berupa bullet list vertikal, teks menempel ke tepi layar tanpa padding, tanpa warna latar.
- CSS minimal yang wajib ada (sesuaikan palet dengan konteks, strukturnya jangan dihilangkan):
  - Variabel palet: `--bg`, `--surface`, `--text`, `--muted`, `--accent`, `--line`.
  - `font-family` eksplisit di `body` (tumpukan font sistem, mis. `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`) dan `line-height` minimal 1.5.
  - `header` dengan `display: flex` + `justify-content: space-between`; nav berupa daftar horizontal (`display: flex; gap; list-style: none`) — JANGAN `<ul>` polos di dalam `<nav>`.
  - Hero: `padding` besar + `h1` dengan ukuran jelas + satu tombol CTA (`.btn`: warna aksen, teks kontras, `border-radius`, `padding`).
  - Kartu/konten: `background` permukaan + `border` + `border-radius` + `padding`.
  - Satu aturan responsif (`@media (min-width: 768px)`) untuk layar besar.
 - Simpel, jangan penuh: banyak ruang kosong (padding lega, jarak antar-section besar), satu fokus per layar — tampilan yang lega lebih bagus daripada yang padat.
- Contoh kerangka CSS minimal wajib (ganti paletnya sesuai konteks, jangan hapus bagiannya):

```css
:root {
  --bg: #171310; --surface: #241d18; --text: #f5efe6; --muted: #c9b8a3;
  --accent: #d97706; --accent-text: #1a120b; --line: #3a2f26;
  --radius: 14px;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--font); line-height: 1.6; }
a { color: var(--accent); text-decoration: none; }
header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; }
.nav-list { display: flex; gap: 20px; list-style: none; margin: 0; padding: 0; }
.nav-list a { color: var(--text); }
.hero { padding: 56px 20px; text-align: center; }
.hero h1 { font-size: 2rem; margin: 0 0 12px; }
.btn { display: inline-block; background: var(--accent); color: var(--accent-text); padding: 12px 24px; border-radius: 999px; font-weight: 700; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 20px; }
@media (min-width: 768px) { .hero h1 { font-size: 2.75rem; } }
```

- Struktur HTML-nya mengikuti CSS di atas: `<header>` berisi nama + `<nav><ul class="nav-list">`, lalu `<main>` berisi `<section class="hero">` dan kartu konten. Jangan menulis `<nav><ul>` tanpa class.
- Model yang lemah di desain WAJIB meniru kerangka di atas (ganti palet + teks saja) daripada mengarang dari nol — kerangka yang ditiru dan diisi benar lebih baik daripada halaman polos.

## Cek kualitas visual (sebelum menyatakan selesai)

Selain "Cara menguji" di bawah, jalankan cek ini untuk SETIAP halaman yang dibuat/diubah — ini yang dicek self-check kode (lihat `src/agent/self-check.ts`) dan harus lolos sebelum run dinyatakan selesai:

1. File `.html` halaman penuh memuat `<style>` atau link stylesheet — kalau tidak ada, GAGAL.
2. CSS-nya mendeklarasikan `font-family` dan minimal satu warna (hex/`rgb`) — kalau tidak ada, GAGAL.
3. Nav (bila ada) bukan bullet list polos: `<ul>` di dalam `<nav>` wajib punya `class` dan ditata flex — kalau tidak ada, GAGAL.
4. Halaman punya `header` + hero + CTA — kalau tidak ada, perbaiki.
5. Buka preview dan LIHAT hasilnya (pakai `inspect_image` bila tersedia): halaman tidak boleh terlihat seperti dokumen polos — font default, link biru, bullet list = GAGAL, perbaiki dulu.

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
- Mengirim halaman tanpa CSS nyata (tampilan default browser: serif Times, link biru, nav bullet list). Ini hasil GAGAL — lihat "CSS wajib" di atas.
- Membuat halaman yang terlihat seperti template: hero generik + 3 kartu fitur + footer. Kalau bisa dipakai untuk produk apa pun, desainnya belum punya karakter.
- Menambah animasi berat sebelum kontennya benar. Konten dulu, hiasan belakangan.
- Mengabaikan HP: menguji hanya di layar besar lalu menganggap selesai.
- Menulis teks contoh dan berencana "nanti diganti" — teks contoh yang tertinggal adalah bug.
