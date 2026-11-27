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

describe("stop membebaskan UI yang macet", () => {
  it("stopRun mengenali run yang sudah hilang (404) dan mematikan busy", () => {
    expect(js).toMatch(
      /async function stopRun\(\) \{[\s\S]*?r\.status === 404[\s\S]*?setBusy\(false\)/,
    );
  });
});

describe("tab Eval di folder sheet", () => {
  it("markup: tombol tab + body Eval dengan select provider, daftar tugas, tombol jalan", () => {
    expect(html).toContain('data-ftab="evals"');
    expect(html).toContain('id="tabEvals"');
    expect(html).toContain('id="evalModelSelect"');
    expect(html).toContain('id="evalTaskList"');
    expect(html).toContain('id="evalRunBtn"');
    expect(html).toContain('id="evalList"');
  });

  it("app.js: switchFolderTab menangani evals dan renderSheetEvals memakai /api/evals", () => {
    expect(js).toContain('$("#tabEvals").hidden = tabName !== "evals"');
    expect(js).toContain("renderSheetEvals");
    expect(js).toContain('fetchJson("/api/evals")');
    expect(js).toContain('fetch("/api/evals", {');
    expect(js).toContain("toggleEvalLog");
  });

  it("css punya daftar tugas scroll + blok log ekor", () => {
    expect(css).toContain(".eval-tasks");
    expect(css).toContain(".eval-log");
  });
});

describe("unduh transkrip di riwayat", () => {
  it("renderSheetHistory punya tautan transcript di samping ZIP", () => {
    expect(js).toContain("/transcript");
    expect(js).toContain("Unduh transkrip percakapan (.md)");
    expect(js).toMatch(
      /tr\.href = `\/api\/sessions\/\$\{sess\.session_id\}\/transcript`/,
    );
    expect(js).toMatch(/item\.append\(mainEl, dl, tr, del\)/);
  });
});
