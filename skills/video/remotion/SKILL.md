---
name: remotion
category: video
description: Gunakan saat pengguna ingin membuat video, animasi, atau motion graphic dengan Remotion.
---
# Remotion

Skill ini dipakai setiap kali tugasnya membuat atau mengubah video dengan Remotion.
Baca skill ini sampai habis SEBELUM menulis file pertama.

## Kapan dipakai
- Membuat video dari nol (intro, promo, motion graphic, animasi teks).
- Mengubah durasi, teks, warna, atau timing video Remotion yang sudah ada.
- Menambah audio, musik latar, atau beberapa scene ke video.

## Aturan keras Root.tsx (kegagalan nyata 28 Nov 2026)
`src/Root.tsx` HARUS mengekspor `RemotionRoot` sebagai komponen yang me-render
`<Composition>` (contoh di bawah). Empat pola ini SUDAH dicoba agent dan SEMUANYA
gagal (0 komposisi terdaftar) — jangan pernah dipakai: `export const RemotionRoot
= MyComponent;`, `export default MyComponent;`, `registerRoot(MyComponent);`,
array komposisi. `registerRoot` hanya ada di `src/index.ts`, dan hanya dengan
`RemotionRoot` — bukan dengan komponen scene. Kalau `npx remotion compositions`
menghasilkan 0, baca errornya sampai paham, jangan menebak pola lain.
Untuk video 3D, baca dulu `remotion-video-creation/rules/3d.md` (ThreeCanvas +
`useCurrentFrame`, JANGAN `useFrame()`) dan `rules/compositions.md`.

## Setup project
- Kalau belum ada project video, buat dengan scaffold kosong:
  ```bash
  npx create-video@latest --yes --blank --no-tailwind my-video
  ```
  Perintah `npm install` di server pemilik sudah auto-izin (aturan pemilik 28 Nov 2026).
- Kalau project sudah ada (ada `package.json`), pasang dependensi yang kurang secara manual:
  ```bash
  npm install remotion@4.0.544 @remotion/cli@4.0.544 react@18.3.1 react-dom@18.3.1
  ```
  Remotion adalah dependensi **project video** (bukan Bikinin-Ai sendiri); tool `render_video` memakai `node_modules/.bin/remotion` project kalau ada, kalau tidak `npx --yes remotion@4.0.544` (lebih lambat).
- File wajib di project video:
  - `package.json` — berisi `remotion`, `@remotion/cli`, `react`, `react-dom`.
  - `tsconfig.json` — `jsx: react-jsx`, `moduleResolution: bundler`, `skipLibCheck: true`.
  - `src/index.ts` — memanggil `registerRoot(RemotionRoot)`.
  - `src/Root.tsx` — mendaftarkan `<Composition>` (lihat di bawah).
  - `remotion.config.ts` — `Config.setVideoImageFormat("jpeg")` dan
    `Config.setOverwriteOutput(true)` supaya render ulang tidak bertanya.
- Render pertama mengunduh browser headless Remotion (chrome-headless-shell,
  ~243 MB) ke `node_modules/.remotion/`. Butuh internet.
- Jangan bekerja di `/tmp` (512 MB): `node_modules` + cache bundling bisa melebihi itu.

## Struktur komposisi
- Satu `<Composition>` = satu video. Daftarkan di `src/Root.tsx`:
  ```tsx
  import { Composition } from "remotion";
  import { Intro } from "./Intro";

  export const RemotionRoot: React.FC = () => (
    <>
      <Composition
        id="Intro"
        component={Intro}
        durationInFrames={300}
        fps={30}
        width={1280}
        height={720}
      />
    </>
  );
  ```
- Tentukan di awal: `fps` (pakai 30), `durationInFrames` (durasi detik × fps),
  `width`/`height` (default 1280×720). Jangan mengubah angka ini di tengah jalan tanpa
  menghitung ulang timing animasi.
- Props awal lewat `defaultProps`; `<Still>` hanya untuk gambar diam (thumbnail/cover), bukan video.

## Animasi berbasis frame
- Semua animasi dihitung dari frame, BUKAN dari CSS transition/animation. CSS transition
  tidak berjalan saat render (tiap frame dirender sebagai gambar diam).
- `useCurrentFrame()` — nomor frame saat ini (0 sampai `durationInFrames - 1`).
- `useVideoConfig()` — `fps`, `durationInFrames`, `width`, `height` komposisi aktif.
- `interpolate(frame, [awal, akhir], [nilaiAwal, nilaiAkhir], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })` — ubah frame jadi angka (opacity, posisi, skala). Selalu pakai `clamp` supaya nilai tidak lari di luar rentang.
- `spring({ frame, fps, config: { damping: 100 } })` — gerakan memantul yang halus
  (masuk layar, pop). Jangan pakai spring untuk gerakan yang harus linear.
- `<Sequence from={90} durationInFrames={60}>` — tampilkan scene/komponen hanya pada
  rentang frame tertentu. Scene berurutan = beberapa `<Sequence>` dengan `from` berbeda.
- Audio: `<Audio src={staticFile("musik.mp3")} />` (file di `public/`); volume pakai `interpolate` untuk fade.
- Teks: ukuran font dihitung dari lebar video (judul 80–100px di 1280×720).

## Render via CLI (urutan wajib)
1. Lihat daftar komposisi dan ukur durasi/resolusi aslinya:
   ```bash
   npx remotion compositions
   ```
   Keluaran contoh: `Intro    30      1280x720       300 (10.00 sec)`.
2. Cek satu frame diam (still) DULU — tool `render_video` melakukannya otomatis (frame tengah). Jangan pernah render penuh tanpa still.
   ```bash
   npx remotion still Intro out/still.png --frame=150
   ```
   Buka PNG-nya: teks terbaca? Layout tidak terpotong? Kalau jelek, perbaiki kode, lalu still lagi.
3. Render penuh (hanya setelah still bagus):
   ```bash
   npx remotion render Intro out/video.mp4
   ```
- Pakai tool `render_video` (bukan perintah mentah) supaya batas durasi/resolusi dan
  pengecekan still + verifikasi MP4 selalu ditegakkan. Argumen: `projectDir` (default `.`),
  `compositionId` (wajib), `output` (default `out/video.mp4`), `frame` (opsional, default
  frame tengah).
- Verifikasi hasil dengan `ffprobe` (sudah terinstal bersama ffmpeg):
  ```bash
  ffprobe -v error -show_entries format=duration -show_entries stream=codec_type,codec_name,width,height -of default=noprint_wrappers=1 out/video.mp4
  ```
  Harus ada satu video stream (h264), resolusi sesuai komposisi, durasi sesuai hitungan.

## Batas performa
- Durasi maksimal video: `BIKININ_MAX_VIDEO_SECONDS` (default 30 detik). Tool `render_video`
  menolak komposisi yang lebih panjang — pecah jadi beberapa video kalau perlu.
- Resolusi maksimal: 1280×720 (720p). Jangan render 1080p di mesin 2-core kecuali
  pemilik meminta eksplisit dan paham rendernya jauh lebih lambat.
- Patokan (mesin lambat): still 720p ~7 dtk; render 10 dtk 720p ~16 dtk; bundling awal ~30 dtk. Timeout tool: still 180 dtk, render 600 dtk.
- Server jalan di VPS (bukan Codespaces): render seperlunya, cek still dulu, jangan render ulang berkali-kali tanpa perubahan.

## Contoh: intro 10 detik dengan teks animasi
`src/Intro.tsx` (terbukti render: 300 frame, 30 fps, 1280×720):
```tsx
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: "clamp" });
  const scale = spring({ frame, fps, config: { damping: 100 } });
  return (
    <AbsoluteFill style={{ backgroundColor: "#05060b", justifyContent: "center", alignItems: "center" }}>
      <div style={{ opacity, transform: `scale(${scale})`, color: "#fff", fontSize: 90, fontFamily: "sans-serif", fontWeight: 800 }}>
        Halo, ini intro!
      </div>
    </AbsoluteFill>
  );
};
```
Alur: fade-in 1 dtk, membesar dengan spring.

## Cara menguji
- `npx remotion compositions` menampilkan komposisi dengan fps, resolusi, durasi yang benar.
- Still frame tengah bagus (teks utuh, kontras terbaca) → render penuh via `render_video` → `ffprobe` MP4 (durasi pas, ada stream h264) → putar di HP.

## Kesalahan umum
- Lupa `clamp` di `interpolate` — nilai melesat di luar rentang sebelum/sesudah animasi.
- `durationInFrames` tidak dihitung dari fps (mis. 10 detik di 30 fps = 300 frame, bukan 10).
- Bekerja di `/tmp` — disk penuh di tengah bundling (ENOSPC).
- Mengubah `width`/`height` komposisi tapi lupa menyesuaikan ukuran font dan posisi.
- Memakai `<Still>` untuk video atau lupa `id` komposisi saat render (tanpa `id`, CLI membuka pemilih interaktif dan gagal di terminal).
