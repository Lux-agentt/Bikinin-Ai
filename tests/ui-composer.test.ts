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
const server = readFileSync(
  new URL("../src/server/http.ts", import.meta.url),
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

describe("panel kode live menampilkan rencana + tool yang sedang jalan", () => {
  it("plan_updated juga tampil di panel kode (bukan cuma panel Todo)", () => {
    expect(js).toMatch(
      /case "plan_updated":[\s\S]*?renderPlan\(e\.items\)[\s\S]*?showCode\("Rencana", planBody\)/,
    );
  });

  it("tool_call_started langsung menampilkan tool + argumen (tanpa tunggu selesai)", () => {
    expect(js).toMatch(
      /case "tool_call_started":[\s\S]*?thinkLine\(e\.call_id, e\.label\)[\s\S]*?formatToolCall\(e\.tool, e\.args\)[\s\S]*?showCode\(e\.tool === "update_plan" \? "Rencana" : e\.label, startedBody\)/,
    );
  });

  it("update_plan diformat sebagai baris rencana, bukan JSON mentah", () => {
    expect(js).toMatch(
      /function formatToolCall\(tool, args\) \{[\s\S]*?if \(!args \|\| typeof args !== "object"\) return ""[\s\S]*?tool === "update_plan"[\s\S]*?return formatPlan\(args\.items\)/,
    );
    expect(js).toMatch(/function formatPlan\(items\) \{/);
  });

  it("formatPlan memakai tanda status yang sama dengan panel Todo + batas 2000", () => {
    expect(js).toContain(
      'const PLAN_MARKS = { done: "✓", doing: "›", pending: "○" }',
    );
    expect(js).toMatch(
      /return capText\(lines\.join\("\\n"\), 2000\)/,
    );
  });

  it("argumen tool dipotong per nilai (300) dan total (1500); argumen kosong aman", () => {
    expect(js).toContain("capText(text, 300)");
    expect(js).toMatch(
      /return capText\(lines\.join\("\\n"\), 1500\)/,
    );
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

describe("nama + logo kuxagent", () => {
  it("judul, meta, dan wordmark memakai kuxagent (bukan Bikinin)", () => {
    expect(html).toContain("<title>kuxagent — Studio Agent Web Builder</title>");
    expect(html).toContain(
      'content="kuxagent — Studio Agent Web Builder.',
    );
    expect(html).toContain(
      'kux<span class="ai grad-text">agent</span>',
    );
    expect(html).not.toContain("Bikinin");
  });

  it("logo baru dipakai di rail, header, hero + favicon", () => {
    expect(html).toContain(
      '<link rel="icon" href="/logo.png" type="image/png" />',
    );
    expect(html.match(/<img src="\/logo\.png" alt="kuxagent"/g)).toHaveLength(
      3,
    );
    expect(css).toMatch(/\.logo-tile img\s*\{[^}]*object-fit:\s*cover/);
  });

  it("server melayani /logo.png sebagai aset statis", () => {
    expect(server).toContain('"/logo.png"');
    expect(server).toContain('type: "image/png"');
  });

  it("identitas agent di system prompt memakai kuxagent", () => {
    const prompt = readFileSync(
      new URL("../prompts/system-prompt.md", import.meta.url),
      "utf8",
    );
    expect(prompt).toContain("Kamu adalah kuxagent,");
    expect(prompt).not.toContain("Bikinin AI");
  });
});

describe("pindah chat bolak-balik (riwayat / Tab Baru)", () => {
  it("syncFolderPreviews tahan saat hero tidak di DOM (tidak melempar)", () => {
    // Elemen preview folder tinggal di dalam #hero; saat pengguna berada
    // di dalam chat, hero terlepas dan $("#fhCount") null — tulis langsung
    // melempar dan renderRail() tidak pernah jalan.
    expect(js).toContain("function setTextIfPresent(sel, text)");
    expect(js).not.toMatch(/\$\("#fhCount"\)\.textContent/);
    expect(js).not.toMatch(/\$\("#fsCount"\)\.textContent/);
    expect(js).toMatch(
      /function syncFolderPreviews\(\) \{[\s\S]*?renderRail\(sessions\)/,
    );
  });

  it("restoreSession: satu kejadian rusak tidak menggagalkan restore; think run putus ditutup", () => {
    expect(js).toMatch(
      /async function restoreSession\(sessionId\) \{[\s\S]*?state\.runId = null/,
    );
    expect(js).toMatch(
      /async function restoreSession\(sessionId\) \{[\s\S]*?try \{[\s\S]*?for \(const ev of run\.events\) \{[\s\S]*?handle\(ev\)/,
    );
    expect(js).toMatch(
      /async function restoreSession\(sessionId\) \{[\s\S]*?finally \{[\s\S]*?state\.replaying = false[\s\S]*?if \(state\.think\) finishThink\("stopped", state\.think\.count\)/,
    );
  });

  it("resetSession membersihkan blok think + timer yang nyangkut", () => {
    expect(js).toMatch(
      /function resetSession\(\) \{[\s\S]*?clearInterval\(state\.timerInt\)[\s\S]*?state\.think = null/,
    );
  });

  it("riwayat bisa diklik dan Tab Baru memanggil resetSession", () => {
    expect(js).toContain("void restoreSession(sess.session_id)");
    expect(js).toContain(
      '$("#resetBtn").addEventListener("click", resetSession)',
    );
    expect(js).toContain(
      '$("#railNew").addEventListener("click", resetSession)',
    );
  });
});

describe("kartu preview: konten tidak terpotong, badge tidak menumpuk", () => {
  it("fitThumb mengizinkan tinggi sampai 320px", () => {
    expect(js).toMatch(
      /Math\.max\(150, Math\.min\(320, Math\.round\(560 \* scale\)\)\)/,
    );
  });

  it("badge Live pindah ke result-top (di samping ver-pills), bukan di atas iframe", () => {
    const badgeAt = html.indexOf('class="thumb-badge"');
    const pillsAt = html.indexOf('class="ver-pills"');
    expect(badgeAt).toBeGreaterThan(pillsAt);
    const wrapBlock = html.match(
      /<div class="thumb-wrap"[^>]*>([\s\S]*?)<\/div>/,
    );
    expect(wrapBlock).not.toBeNull();
    expect(wrapBlock![1]).not.toContain("thumb-badge");
    expect(css).toMatch(/\.thumb-badge\s*\{[^}]*position:\s*static/);
    expect(css).not.toMatch(/\.thumb-badge\s*\{[^}]*position:\s*absolute/);
    expect(css).not.toMatch(/\.thumb-badge\s*\{[^}]*backdrop-filter/);
    expect(js).toContain('card.querySelector(".thumb-badge")');
  });
});
