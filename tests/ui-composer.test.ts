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

describe("UI proses run simpel (tidak penuh teks)", () => {
  it("baris langkah hanya label tool — ringkasan tidak ditempel", () => {
    expect(js).not.toContain("— ${e.summary}");
    expect(js).toMatch(/label\.className = "think-line-text"/);
  });

  it("langkah menampilkan cuplikan kode satu baris di bawah label", () => {
    expect(js).toMatch(/function setStepCode\(row, text\)/);
    expect(js).toMatch(/row\.snippet\.textContent = capText\(first, 140\)/);
    expect(js).toMatch(
      /case "file_changed":[\s\S]*?setStepCode\(row, e\.diff\)/,
    );
    expect(js).toMatch(/if \(e\.output_preview && !row\.snippetFromDiff\)/);
    expect(css).toMatch(/\.think-snippet \{[^}]*text-overflow: ellipsis/);
  });

  it("panel kode hanya cuplikan pendek, bukan dinding teks", () => {
    expect(js).toMatch(
      /function showCode\(title, body\) \{[\s\S]*?capText\(body, 600\)/,
    );
  });

  it("baris think dipotong bila terlalu panjang", () => {
    expect(js).toMatch(
      /function thinkLine\(callId, text\) \{[\s\S]*?const short = capText\(text, 120\)/,
    );
  });

  it("langkah selesai meredup, langkah berjalan bertanda", () => {
    expect(css).toMatch(/\.think-line\.ok \{[^}]*opacity: 0\.6/);
    expect(css).toMatch(/\.think-line::before \{[^}]*content: "› "/);
  });
});

describe("tampilan proses kayak Z.ai (lipat saat selesai)", () => {
  it("finishThink melipat blok untuk semua status akhir, bukan cuma completed", () => {
    expect(js).toMatch(
      /function finishThink\(status, steps\) \{[\s\S]*?t\.block\.classList\.add\("collapsed"\)/,
    );
    expect(js).not.toMatch(
      /if \(status === "completed"\) t\.block\.classList\.add\("collapsed"\)/,
    );
  });

  it("blok mulai terlipat sejak run jalan (bukan cuma setelah selesai)", () => {
    expect(js).toMatch(
      /function addThink\(label\) \{[\s\S]*?block\.classList\.add\("collapsed"\)/,
    );
    // Header tetap hidup saat terlipat: label = hitungan file + perintah
    // (bukan lagi langkah terakhir — lihat updateThinkHeader).
    expect(js).toContain("function updateThinkHeader()");
    expect(js).not.toMatch(/t\.labelEl\.textContent = short;/);
  });

  it("header think bisa diketuk untuk buka-tutup (drawer tersembunyi saat lipat)", () => {
    expect(js).toMatch(
      /toggle\.addEventListener\("click", \(\) => \{[\s\S]*?block\.classList\.toggle\("collapsed"\)/,
    );
    expect(html).toContain('class="think-toggle"');
    expect(css).toMatch(
      /\.think-block\.collapsed \.think-drawer \{[^}]*display: none/,
    );
  });
});

describe("stop membebaskan UI yang macet", () => {
  it("stopRun mengenali run yang sudah hilang (404) dan mematikan busy", () => {
    expect(js).toMatch(
      /async function stopRun\(\) \{[\s\S]*?r\.status === 404[\s\S]*?setBusy\(false\)/,
    );
  });

  it("stopRun saat run hilang (404) juga menutup blok think yang nyangkut", () => {
    expect(js).toMatch(
      /Run sudah tidak ada di server[\s\S]*?if \(state\.think\) finishThink\("stopped"/,
    );
  });

  it("stream putus + run tidak ada di server (404) membebaskan UI otomatis", () => {
    expect(js).toMatch(/es\.onerror = \(\) => \{/);
    expect(js).toMatch(/fetch\(`\/api\/runs\/\$\{runId\}\/events`/);
    expect(js).toMatch(/if \(r\.status === 404 && state\.source === es\)/);
    expect(js).toMatch(/toast\("Koneksi ke server putus/);
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
      /async function restoreSession\(sessionId\) \{[\s\S]*?finally \{[\s\S]*?state\.replaying = false/,
    );
    // Run yang masih jalan tidak ikut ditutup paksa saat restore.
    expect(js).toContain(
      "const liveRun = detail.runs.some((r) => r.run_id === state.runId)",
    );
    expect(js).toContain(
      'if (state.think && !liveRun) finishThink("stopped", state.think.count);',
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

describe("logo tanpa kotak biru (hanya logo X)", () => {
  it("tile logo rail + hero transparan, tanpa gradasi biru dan tanpa kilau", () => {
    expect(css).toMatch(/\.logo-tile \{[^}]*background: transparent/);
    expect(css).not.toMatch(/background: linear-gradient\(150deg, #6b9aff/);
    expect(css).not.toMatch(/background: linear-gradient\(165deg, #7ea2ff/);
    expect(css).not.toContain(".hero .logo-tile::after");
  });

  it("ikon header blok proses pakai logo X, bukan titik biru", () => {
    expect(html).toContain('class="think-logo"');
    expect(html).not.toContain("think-dot");
    expect(css).toContain(".think-logo {");
  });
});

describe("baris kuota + petunjuk bawah input dihapus", () => {
  it("HTML tidak lagi memuat quotaLine dan teks petunjuk revisi", () => {
    expect(html).not.toContain("quotaLine");
    expect(html).not.toContain("Ketik revisi kapan saja");
  });

  it("JS tidak lagi memuat refreshQuotaLine, CSS tidak lagi memuat foot-note", () => {
    expect(js).not.toContain("refreshQuotaLine");
    expect(css).not.toContain(".foot-note");
  });
});

describe("drawer kosong disembunyikan + header proses kayak Z.ai", () => {
  it("drawer kosong display none, dilepas begitu ada isi", () => {
    expect(css).toMatch(/\.think-drawer\.empty \{[^}]*display: none/);
    expect(js).toContain('state.think.drawer.classList.add("empty")');
    expect(js).toContain('t.drawer.classList.remove("empty")');
  });

  it("header menampilkan hitungan file + perintah, bukan langkah terakhir", () => {
    expect(js).toContain("function updateThinkHeader()");
    expect(js).toContain("} file · ${t.count} perintah");
    expect(js).toContain("files: new Set()");
    expect(js).toContain('t.files.add(rest.join(" "))');
  });

  it("daftar langkah tampil sebagai pohon (garis + titik)", () => {
    expect(css).toMatch(/\.think-lines \{[^}]*border-left:/);
    expect(css).toMatch(/\.think-line::after \{[^}]*border-radius: 50%/);
  });
});

describe("tombol perjelas tanpa template", () => {
  it("tidak ada lagi template landing page yang tidak cocok dengan isi chat", () => {
    expect(js).not.toContain(
      "Buatkan landing page modern lengkap dengan hero section",
    );
    expect(js).not.toContain(
      "buat tampilannya modern, responsif di HP dan desktop",
    );
  });

  it("input kosong ditegur, input pendek ditambah akhiran umum", () => {
    expect(js).toContain("Tulis perintah dulu, baru ketuk ini untuk memperjelas.");
    expect(js).toContain("kerjakan dengan teliti sampai selesai");
  });
});

describe("pindah chat selagi run jalan", () => {
  it("tidak ada lagi larangan 'Hentikan agent dulu' di reset/restore", () => {
    expect(js).not.toContain('toast("Hentikan agent dulu")');
  });

  it("handle() memilah kejadian run latar berdasarkan run_id", () => {
    expect(js).toContain("runSessionId: null,");
    expect(js).toContain("state.runSessionId !== state.sessionId");
    expect(js).toContain("Agent selesai bekerja di chat lain.");
    expect(js).toContain(
      "detail.runs.some((r) => r.run_id === state.runId)",
    );
  });
});
