import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const html = readFileSync(
  new URL("../public/index.html", import.meta.url),
  "utf8",
);
const css = readFileSync(
  new URL("../public/app.css", import.meta.url),
  "utf8",
);
const js = readFileSync(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);

describe("composer buttons (HP: target sentuh besar)", () => {
  it("tombol aksi 40px, tombol kirim 44px", () => {
    expect(css).toMatch(/\.plus\s*\{[^}]*width:\s*40px/);
    expect(css).toMatch(/\.send\s*\{[^}]*width:\s*44px/);
  });

  it("model pill fleksibel mengisi ruang sisa", () => {
    expect(css).toMatch(/\.mpill\s*\{[^}]*flex:\s*1 1 auto/);
  });
});

describe("animasi coding saat run", () => {
  it("template think punya blok code-anim", () => {
    expect(html).toContain("code-anim");
    expect(html).toContain("code-anim-text");
    expect(html).toContain("code-anim-cursor");
  });

  it("app.js menampilkan, memperbarui, dan menyembunyikan code-anim", () => {
    expect(js).toContain("codeAnim");
    expect(js).toContain("codeAnim.hidden = false");
    expect(js).toContain("codeAnim.hidden = true");
    expect(js).toContain("codeAnimText.textContent = text");
  });

  it("css punya kursor berkedip untuk code-anim", () => {
    expect(css).toContain("@keyframes blinkCursor");
    expect(css).toContain(".code-anim-cursor");
  });
});
