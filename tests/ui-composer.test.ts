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

describe("panel kode live saat run (kode asli, bukan placeholder)", () => {
  it("template think punya blok code-live dan tidak ada code-anim", () => {
    expect(html).toContain("code-live");
    expect(html).toContain("code-live-path");
    expect(html).toContain("code-live-body");
    expect(html).not.toContain("code-anim");
  });

  it("app.js menampilkan kode asli dari diff file_changed dan output tool", () => {
    expect(js).toContain("showCode(");
    expect(js).toContain("codeLive.hidden = false");
    expect(js).toMatch(/file_changed[\s\S]*?e\.diff[\s\S]*?showCode/);
    expect(js).toMatch(/output_preview[\s\S]*?showCode/);
    expect(js).not.toContain("codeAnim");
  });

  it("css: code-live berlatar solid gelap (bukan transparan), tanpa shimmer bar", () => {
    expect(css).toContain(".code-live");
    expect(css).toMatch(/\.code-live\s*\{[^}]*background:\s*#[0-9a-f]{6}/);
    expect(css).not.toContain(".code-anim");
    expect(css).not.toContain("code-anim-bars");
    expect(css).not.toContain("@keyframes blinkCursor");
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
