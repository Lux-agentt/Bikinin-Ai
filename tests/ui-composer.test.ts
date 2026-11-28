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
const prompt = readFileSync(
  new URL("../prompts/system-prompt.md", import.meta.url),
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

  it("langkah selesai tidak lagi bertanda ✓ dan cuplikannya terlipat", () => {
    // ✓ di tiap baris bikin daftar kelihatan sudah selesai semua padahal
    // run masih jalan — ✓ hanya untuk header run dan langkah rencana.
    expect(css).toMatch(/\.think-line\.ok::before \{[^}]*content: "· "/);
    expect(css).not.toMatch(/\.think-line\.ok::before \{[^}]*content: "✓ "/);
    expect(js).toMatch(
      /case "tool_call_finished":[\s\S]*?if \(e\.ok && row\.snippet\) row\.snippet\.hidden = true;/,
    );
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
      /async function stopRun\(\) \{[\s\S]*?const runId = ownRunId\(\)[\s\S]*?r\.status === 404[\s\S]*?untrackRun\(runId\)[\s\S]*?refreshBusyUI\(\)/,
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
    expect(js).toMatch(
      /if \(r\.status === 404 && state\.sources\.get\(runId\) === es\)/,
    );
    expect(js).toMatch(/toast\("Koneksi ke server putus/);
  });

  it("stop yang berhasil langsung menutup blok think (tidak tunggu run_finished)", () => {
    expect(js).toMatch(
      /toast\("Agent dihentikan\."\)/,
    );
    expect(js).toMatch(
      /if \(state\.think\) finishThink\("stopped", state\.think\.count\);/,
    );
  });
});

describe("lanjutkan run yang berhenti (bukan mulai dari awal)", () => {
  it("tombol Lanjutkan muncul untuk semua run yang bisa dilanjutkan", () => {
    expect(js).toContain("if (e.resumable) showResume(e.run_id, e.status);");
    expect(js).toContain("function showResume(runId, status) {");
  });

  it("catatan Lanjutkan menjelaskan: meneruskan, bukan mulai dari awal", () => {
    expect(js).toContain("Run dihentikan di tengah jalan. Lanjutkan");
    expect(js).toContain("Run berhenti karena error. Lanjutkan");
    expect(js).toContain("bukan mulai dari awal");
  });
});

describe("refresh tidak membuat run hilang (pindai semua sesi)", () => {
  it("reattachLiveRun mencari run yang belum selesai di semua sesi, bukan cuma yang terbaru", () => {
    expect(js).toMatch(
      /for \(const sess of list\.slice\(0, 5\)\)[\s\S]*?unfinished\.length > 0[\s\S]*?await restoreSession\(sess\.session_id\)/,
    );
  });
});

describe("izin tertunda tidak dibuka otomatis saat pindah chat", () => {
  // Aturan user 2026-11-28: lembar izin muncul tiap pindah chat. Sekarang
  // restore cuma menyimpan izin tertunda + label "Menunggu izin"; lembar
  // baru dibuka kalau pengguna mengetuk label bar proses.
  it("restore menyimpan pendingApproval, bukan openApproval", () => {
    expect(js).toContain(
      "state.pendingApproval = { req, runId: liveRun.run_id };",
    );
    expect(js).not.toContain(
      "if (req && !resolved) openApproval(req, liveRun.run_id);",
    );
  });

  it("label bar proses menunjukkan 'Menunggu izin' saat ada izin tertunda", () => {
    expect(js).toContain(
      't.labelEl.textContent = "Menunggu izin · ketuk untuk menjawab";',
    );
  });

  it("ketuk label membuka lembar izin yang tertunda", () => {
    expect(js).toContain('labelEl.addEventListener("click", () => {');
    expect(js).toContain(
      "openApproval(state.pendingApproval.req, state.pendingApproval.runId);",
    );
  });

  it("izin tertunda dibersihkan saat run selesai / lembar ditutup", () => {
    expect(js).toContain("state.pendingApproval = null;");
  });

  it("run_finished membebaskan slot SEBELUM jeda replay (tombol tidak nyangkut)", () => {
    // Regresi 2026-11-28: run_finished yang diputar ulang berhenti di
    // `if (state.replaying) break` sebelum finishRunLive — run tetap
    // tercatat, input terkunci walau agent sudah selesai.
    expect(js).toMatch(
      /case "run_finished": \{[\s\S]*?untrackRun\(e\.run_id\);[\s\S]*?refreshBusyUI\(\);[\s\S]*?drainQueue\(\);[\s\S]*?if \(state\.replaying\) break;/,
    );
  });
});

describe("prompt to-the-point (agent cepat, tidak bertele-tele)", () => {
  it("rencana maks 3 langkah dan hanya diperbarui kalau berubah", () => {
    expect(prompt).toContain("maks 3 langkah");
    expect(prompt).toContain("Perbarui rencana hanya kalau rencana berubah");
  });

  it("tool call independen digabung dalam satu jawaban", () => {
    expect(prompt).toContain(
      "gabungkan beberapa tool call independen dalam SATU jawaban",
    );
  });

  it("tugas website: baca skill paling relevan dulu, bukan semuanya", () => {
    expect(prompt).toContain("baca skill yang paling relevan dulu");
    expect(prompt).toContain("jangan baca semuanya di awal");
  });

  it("file terpotong: baca dengan max_lines lebih besar, jangan baca ulang yang sama", () => {
    expect(prompt).toContain("max_lines` lebih besar (maks 2000)");
    expect(prompt).toContain(
      "jangan baca ulang file yang sama dengan parameter yang sama",
    );
  });

  it("bagi tugas ke subagent: satu baca, satu cek error, jalan bareng maks 5", () => {
    expect(prompt).toContain("Bagi tugas ke subagent (`delegate`)");
    expect(prompt).toContain("satu cek error");
    expect(prompt).toContain("jalan bareng (maks 5)");
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

describe("nama + logo luxagent", () => {
  it("judul, meta, dan wordmark memakai luxagent (bukan Bikinin)", () => {
    expect(html).toContain("<title>luxagent — Studio Agent Web Builder</title>");
    expect(html).toContain(
      'content="luxagent — Studio Agent Web Builder.',
    );
    expect(html).toContain(
      'lux<span class="ai grad-text">agent</span>',
    );
    expect(html).not.toContain("Bikinin");
  });

  it("logo baru dipakai di rail, header, hero + favicon", () => {
    expect(html).toContain(
      '<link rel="icon" href="/logo.png" type="image/png" />',
    );
    expect(html.match(/<img src="\/logo\.png" alt="luxagent"/g)).toHaveLength(
      3,
    );
    expect(css).toMatch(/\.logo-tile img\s*\{[^}]*object-fit:\s*cover/);
  });

  it("server melayani /logo.png sebagai aset statis", () => {
    expect(server).toContain('"/logo.png"');
    expect(server).toContain('type: "image/png"');
  });

  it("identitas agent di system prompt memakai luxagent", () => {
    const prompt = readFileSync(
      new URL("../prompts/system-prompt.md", import.meta.url),
      "utf8",
    );
    expect(prompt).toContain("Kamu adalah luxagent,");
    expect(prompt).not.toContain("Bikinin AI");
  });

  it("tugas website: baca skill paling relevan dulu, bukan semuanya", () => {
    const prompt = readFileSync(
      new URL("../prompts/system-prompt.md", import.meta.url),
      "utf8",
    );
    // Dulu (push 48): wajib baca SEMUA skill website — lambat, tiap
    // read_skill menambah langkah. Sekarang (push 53, to-the-point): baca
    // yang paling relevan dulu, sisanya hanya kalau tugasnya butuh.
    expect(prompt).toContain(
      "Khusus tugas website: baca skill yang paling relevan dulu",
    );
    expect(prompt).toContain("jangan baca semuanya di awal");
    expect(prompt).not.toContain("cari SEMUA skill yang berkaitan");
  });

  it("pratinjau pakai tool preview, bukan server manual", () => {
    const prompt = readFileSync(
      new URL("../prompts/system-prompt.md", import.meta.url),
      "utf8",
    );
    expect(prompt).toContain("Untuk pratinjau website pakai tool `preview`");
    expect(prompt).toContain("JANGAN jalankan server sendiri");
    expect(prompt).toContain("python3 -m http.server");
  });
});

describe("pemilih model dropdown", () => {
  it("model dipilih lewat <select> native, bukan daftar tombol semua model", () => {
    expect(html).toContain('<select');
    expect(html).toContain('id="modelSelect"');
    expect(html).not.toContain('<div id="modelList">');
    expect(js).toContain('$("#modelSelect")');
    expect(js).toContain('document.createElement("option")');
    expect(js).not.toContain('b.className = "pop-i"');
  });

  it("ganti pilihan menyimpan model + menutup popover", () => {
    expect(js).toContain(
      '$("#modelSelect").addEventListener("change"',
    );
    expect(js).toMatch(
      /addEventListener\("change", \(\) => \{[\s\S]*?state\.curModel = \$\("#modelSelect"\)\.value[\s\S]*?savePrefs\(\)[\s\S]*?closePops\(\)/,
    );
  });

  it("CSS dropdown ada, aturan daftar tombol lama sudah dibersihkan", () => {
    expect(css).toContain(".model-select {");
    expect(css).not.toContain(".pop-i {");
    expect(css).not.toContain(".pop-check {");
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
      /async function restoreSession\(sessionId\) \{[\s\S]*?state\.lastRunId = null/,
    );
    expect(js).toMatch(
      /async function restoreSession\(sessionId\) \{[\s\S]*?try \{[\s\S]*?for \(const ev of run\.events\) \{[\s\S]*?handle\(ev\)/,
    );
    expect(js).toMatch(
      /async function restoreSession\(sessionId\) \{[\s\S]*?finally \{[\s\S]*?state\.replaying = false/,
    );
    // Run yang masih jalan tidak ikut ditutup paksa saat restore — malah
    // disambung lagi (reattach), supaya refresh tidak menampilkan run
    // sebagai "berhenti" padahal server masih mengerjakannya.
    expect(js).toContain("const unfinished = detail.runs.filter(");
    expect(js).toContain(
      'if (state.think && !liveRun) finishThink("stopped", state.think.count);',
    );
    expect(js).toContain("void reattachRun(detail.session_id, liveRun.run_id);");
    // Persetujuan yang menggantung TIDAK dibuka otomatis setelah restore
    // (aturan user 2026-11-28: lembar izin muncul tiap pindah chat) —
    // disimpan sebagai izin tertunda; label bar proses menunjukkan
    // "Menunggu izin", ketuk label baru lembarnya kebuka. Run tetap
    // menunggu jawaban; tidak ada yang dijawab diam-diam.
    expect(js).toContain(
      'find((e) => e.type === "approval_requested")',
    );
    expect(js).toContain(
      "state.pendingApproval = { req, runId: liveRun.run_id };",
    );
    expect(js).not.toContain(
      "if (req && !resolved) openApproval(req, liveRun.run_id);",
    );
    // openApproval menerima run_id eksplisit: kejadian riwayat tidak
    // membawa run_id, dan ownRunId() masih null saat reattach belum
    // selesai — tanpa ini jawabannya selalu ditolak "sudah tidak aktif".
    expect(js).toContain("function openApproval(e, runId) {");
    expect(js).toContain("state.approvalRunId = runId ?? e.run_id ?? ownRunId();");
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
    // Status jalan vs selesai harus langsung kelihatan: "Bekerja · …"
    // saat run jalan, "Selesai ✓ · …" saat run berakhir.
    expect(js).toContain('"Bekerja · " +');
    expect(js).toContain("`${t.files.size} file · ${t.count} perintah`");
    expect(js).toContain("Selesai ✓ · ${steps} langkah");
    expect(js).toContain("files: new Set()");
    expect(js).toContain('t.files.add(rest.join(" "))');
  });

  it("label selesai tampil lebih terang dari label saat bekerja", () => {
    expect(css).toMatch(/\.think-block\.done \.think-label \{[^}]*color: var\(--text\)/);
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

  it("run bareng: state run/source per sesi, cap 3, antrean cuma saat penuh", () => {
    expect(js).toContain("runs: new Map(),");
    expect(js).toContain("sources: new Map(),");
    expect(js).toContain("const MAX_PARALLEL = 5;");
    expect(js).toContain("function ownRunId() {");
    expect(js).toContain("function trackRun(sessionId, runId) {");
    expect(js).toContain("function untrackRun(runId) {");
    expect(js).toContain("if (state.runs.size >= MAX_PARALLEL) {");
  });

  it("refresh/pindah chat menyambung lagi ke run yang masih jalan", () => {
    expect(js).toContain("async function reattachRun(sessionId, runId) {");
    expect(js).toContain("async function reattachLiveRun() {");
    expect(js).toContain("function probeRunAlive(runId) {");
    expect(js).toContain("void reattachLiveRun();");
    // Dulu cuma sesi terbaru yang dicek (list[0]); sekarang pemindaian
    // berurutan menemukan run di sesi lama juga (push 53).
    expect(js).toContain("await restoreSession(sess.session_id);");
    expect(js).not.toContain("await restoreSession(newest.session_id);");
  });

  it("handle() memilah kejadian run latar berdasarkan run_id", () => {
    expect(js).toContain(
      "const evSessionId = e.run_id ? state.runSessions.get(e.run_id) : undefined;",
    );
    expect(js).toContain("evSessionId !== state.sessionId");
    expect(js).toContain("Agent selesai bekerja di chat lain.");
    expect(js).toContain("untrackRun(e.run_id);");
  });
});

describe("antrean pesan saat run jalan di chat lain", () => {
  it("input tidak dikunci saat run aktif di chat lain (hanya run sendiri yang mengunci)", () => {
    expect(js).toContain("queue: [],");
    expect(js).toContain("function refreshBusyUI() {");
    expect(js).toContain(
      "const ownRun = ownRunId() !== null || state.starting;",
    );
    // Input terkunci hanya oleh run chat sendiri — atau selagi pindah chat
    // belum selesai (state.switching, 28 Nov 2026: kirim saat pindah
    // menghentikan run chat lama). Run di chat lain tidak mengunci.
    expect(js).toContain("input.disabled = ownRun || state.switching;");
    expect(js).toContain("switching: false,");
    expect(js).not.toMatch(/input\.disabled = on;/);
  });

  it("kirim saat run lain aktif langsung jalan bareng, antrean cuma saat slot penuh", () => {
    expect(js).toContain("if (ownRunId()) {");
    expect(js).toContain("void stopRun();");
    // start() antre bila sudah MAX_PARALLEL run jalan bareng.
    expect(js).toContain("if (state.runs.size >= MAX_PARALLEL) {");
    expect(js).toContain("queueMessage(state.sessionId, message);");
    expect(js).toContain('note.className = "queued-note";');
    expect(js).toContain(
      "Menunggu giliran — jalan otomatis begitu ada slot run kosong.",
    );
  });

  it("drainQueue menjalankan antrean pertama untuk chat yang dibuka", () => {
    expect(js).toContain("function drainQueue() {");
    expect(js).toContain(
      "const i = state.queue.findIndex((e) => e.sessionId === state.sessionId);",
    );
    expect(js).toContain(
      "void start(entry.message, { alreadyShown: true });",
    );
    expect(js).toContain("if (!opts.alreadyShown) {");
  });

  it("run selesai (sendiri maupun latar) menjalankan antrean", () => {
    expect(js).toMatch(
      /async function finishRunLive[\s\S]*?untrackRun\(e\.run_id\)[\s\S]*?refreshBusyUI\(\)[\s\S]*?drainQueue\(\)/,
    );
    expect(js).toMatch(
      /drainQueue\(\);[\s\S]{0,200}?toast\("Agent selesai bekerja di chat lain\."\)/,
    );
  });

  it("pindah/buka chat menyegarkan tombol/input + menjalankan antrean", () => {
    expect(js).toContain("refreshBusyUI();");
    // 8 titik: run_finished juga menjalankan antrean SEBELUM jeda replay
    // (perbaikan tombol nyangkut 2026-11-28) — slot yang dibebaskan di
    // situ harus langsung dipakai antrean, bukan menunggu finishRunLive.
    expect(js.match(/drainQueue\(\);/g)).toHaveLength(8);
  });

  it("CSS catatan antrean ada", () => {
    expect(css).toContain(".queued-note {");
  });
});

describe("perkiraan selesai (ETA menit)", () => {
  it("ETA dihitung dari kecepatan rencana, bukan batas langkah", () => {
    expect(js).toContain("function computeEtaMin() {");
    expect(js).toContain("state.planItems = items;");
    expect(js).toContain(
      'items.filter((it) => it.status === "done").length',
    );
    expect(js).toContain(
      "Math.max(1, Math.round(((elapsed / done) * remaining) / 60))",
    );
  });

  it("ETA tampil di label Bekerja (di depan hitungan supaya tidak kepotong)", () => {
    expect(js).toContain("const eta = computeEtaMin();");
    expect(js).toContain("`±${eta} mnt · `");
  });

  it("tanpa dasar (belum ada rencana / belum ada langkah selesai) ETA tidak tampil", () => {
    expect(js).toMatch(
      /function computeEtaMin\(\) \{[\s\S]*?if \(done === 0\) return null;/,
    );
    expect(js).toMatch(
      /function computeEtaMin\(\) \{[\s\S]*?if \(remaining <= 0\) return null;/,
    );
  });

  it("timer memperbarui ETA tiap tick + rencana baru dibersihkan tiap run", () => {
    expect(js).toMatch(
      /state\.timerInt = setInterval\(\(\) => \{[\s\S]*?updateThinkHeader\(\);/,
    );
    expect(js).toContain("state.planItems = null;");
  });
});
