// UI logic (ES module), driven by real agent events over SSE.
// All model output is written with textContent or DOM nodes, never raw innerHTML
// (the one exception is syntax highlighting, which escapes first, then wraps tokens).
// Static markup lives in index.html; the browser never sees an API key.
// localStorage is only used for small UI preferences (model + effort), never for
// sessions or skills — those always come from the server.
import { parseBlocks } from "/md.js";

const $ = (s) => document.querySelector(s);
const main = $("#main");
const input = $("#input");
const sendBtn = $("#send");
const heroEl = $("#hero");
const isCoarsePointer = matchMedia("(pointer: coarse)").matches;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const CIRC = 97.39; // 2 * PI * 15.5, matches the ring in app.css
const MAX_PARALLEL = 5; // sama dengan MAX_CONCURRENT_RUNS server — run ke-6 masuk antrean

const state = {
  cfg: null,
  models: [],
  curModel: null,
  curEffort: "sedang",
  runs: new Map(), // sessionId -> runId (run yang sedang jalan; boleh bareng, maks MAX_PARALLEL)
  sources: new Map(), // runId -> EventSource (satu SSE per run yang jalan)
  runSessions: new Map(), // runId -> sessionId (balik dari runs, untuk memilah kejadian)
  lastRunId: null, // run terakhir di chat yang dibuka (untuk tombol Lanjutkan)
  approvalRunId: null, // run pemilik persetujuan yang sedang dibuka
  pendingApproval: null, // { req, runId } — izin menunggu jawaban; TIDAK dibuka otomatis saat pindah/refresh chat (aturan user 2026-11-28: lembar izin muncul tiap pindah chat) — label bar proses menunjukkan "Menunggu izin", ketuk label untuk membuka lembarnya
  sessionId: null,
  queue: [], // antrean pesan { sessionId, message, files, noteEl } — dikirim saat slot run penuh, jalan otomatis begitu ada slot kosong
  starting: false, // start()/resumeRun() sedang upload + POST (kunci ganda sebelum run tercatat)
  busy: false,
  replaying: false,
  lastPrompt: "",
  approvalId: null,
  think: null, // { block, labelEl, timer, linesEl, rows: Map, count }
  planEl: null, // Todo panel (Fase 5), rendered from plan_updated events
  planItems: null, // langkah rencana terakhir (untuk perkiraan menit selesai)
  lastThink: null, // finished think block, for the resume button
  explainEl: null,
  explainRaw: "",
  files: new Map(), // path -> { bytes }
  pendingFiles: [], // File[] chosen via + button, uploaded when the run starts
  versions: [], // { path, bytes, title, content: string|null, runId }
  activeVersion: -1,
  evalSelected: null, // Set<string> | null — tugas eval yang dicentang (null = semua)
  evalModel: null, // provider yang dipilih di tab Eval
  evalOpenLog: null, // id eval yang log-nya sedang dibuka
  resultCard: null,
  overlayVersion: null,
  overlayFiles: [],
  overlayFileIdx: 0,
  revDismissed: false,
  startedAt: 0,
  timerInt: 0,
  toastTimer: 0,
  errorCard: null,
};

const fmtUsd = (n) => "$" + n.toFixed(4);
const fmtIdr = (usd) =>
  "≈ Rp " +
  Math.round(usd * (state.cfg ? state.cfg.usd_idr : 17000)).toLocaleString(
    "id-ID",
  );
const fmtKb = (bytes) => (bytes / 1024).toFixed(1).replace(".", ",") + " KB";
const tpl = (id) => $(id).content.firstElementChild.cloneNode(true);
/** Tulis teks hanya bila elemennya ada di DOM. Elemen preview folder
 *  (#fhCount, #fsCount, ...) tinggal di dalam #hero, jadi null saat
 *  pengguna sedang berada di dalam chat — tanpa guard ini, tiap
 *  syncFolderPreviews() melempar dan renderRail() tidak pernah jalan. */
function setTextIfPresent(sel, text) {
  const el = $(sel);
  if (el) el.textContent = text;
}
const shortText = (s, n) => {
  const a = Array.from(String(s ?? ""));
  return a.length > n
    ? a
        .slice(0, n)
        .join("")
        .replace(/\s+\S*$/, "") + "…"
    : String(s ?? "");
};
const escHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );

// ---------- Helpers ----------

function isNearBottom() {
  return main.scrollHeight - main.scrollTop - main.clientHeight < 140;
}
function scrollDown(force = false) {
  if (force || isNearBottom()) main.scrollTop = main.scrollHeight;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

function setMeters(steps, cost) {
  const max = state.cfg ? state.cfg.max_steps : 0;
  const p = max > 0 ? Math.min(steps / max, 1) : 0;
  $("#ringArc").style.strokeDashoffset = (CIRC * (1 - p)).toFixed(2);
  $("#ringBtn").classList.toggle("full", max > 0 && steps >= max);
  $("#ringLabel").textContent = `${steps}/${max}`;
  $("#stSteps").textContent = `${steps} / ${max}`;
  $("#stCost").textContent = fmtUsd(cost);
  $("#stIdr").textContent = fmtIdr(cost);
}

function updateSendState() {
  sendBtn.disabled = !state.busy && input.value.trim() === "";
}

/** Run yang sedang jalan di chat yang dibuka (null bila tidak ada). */
function ownRunId() {
  return state.sessionId === null
    ? null
    : (state.runs.get(state.sessionId) ?? null);
}

function trackRun(sessionId, runId) {
  state.runs.set(sessionId, runId);
  state.runSessions.set(runId, sessionId);
}

function untrackRun(runId) {
  const sessionId = state.runSessions.get(runId);
  if (sessionId !== undefined && state.runs.get(sessionId) === runId) {
    state.runs.delete(sessionId);
  }
  state.runSessions.delete(runId);
  const src = state.sources.get(runId);
  if (src) {
    src.close();
    state.sources.delete(runId);
  }
}

/** Hitung ulang status tombol/input dari peta run — dipanggil tiap run
 *  mulai/selesai/pindah chat. Input terkunci + tombol jadi Stop hanya
 *  bila chat yang dibuka punya run sendiri; run di chat lain tidak
 *  mengunci chat ini (pesan baru langsung jalan bareng, bukan antre). */
function refreshBusyUI() {
  const wasBusy = state.busy;
  state.busy = state.runs.size > 0;
  // Selama start() masih upload + POST, run belum tercatat — kunci input
  // seperti run sendiri supaya kirim ganda tidak lolos.
  const ownRun = ownRunId() !== null || state.starting;
  sendBtn.classList.toggle("stop", ownRun);
  const icon = $("#tplIcons").content.querySelector(
    `[data-ic="${ownRun ? "stop" : "send"}"]`,
  );
  sendBtn.replaceChildren(icon.firstElementChild.cloneNode(true));
  sendBtn.setAttribute("aria-label", ownRun ? "Hentikan agent" : "Kirim");
  input.disabled = ownRun;
  updateSendState();
  if (wasBusy && !state.busy) input.focus();
}

// ---------- Markdown (DOM only) ----------

function appendInline(parent, parts) {
  for (const p of parts) {
    if (p.t === "text") {
      parent.appendChild(document.createTextNode(p.v));
    } else if (p.t === "link") {
      const a = document.createElement("a");
      a.href = p.href; // the parser only allows http(s)
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = p.v;
      parent.appendChild(a);
    } else {
      const n = document.createElement(
        p.t === "strong" ? "strong" : p.t === "em" ? "em" : "code",
      );
      n.textContent = p.v;
      parent.appendChild(n);
    }
  }
}

function codeBlock(block) {
  const wrap = document.createElement("div");
  wrap.className = "codeblock";
  const bar = document.createElement("div");
  bar.className = "codebar";
  const lang = document.createElement("span");
  lang.textContent = block.lang || "kode";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy";
  copy.textContent = "Salin";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(block.text);
      copy.textContent = "Tersalin";
    } catch {
      copy.textContent = "Gagal";
    }
    setTimeout(() => (copy.textContent = "Salin"), 1600);
  });
  bar.append(lang, copy);
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = block.text;
  pre.appendChild(code);
  wrap.append(bar, pre);
  return wrap;
}

function renderBlock(b) {
  switch (b.t) {
    case "p": {
      const p = document.createElement("p");
      appendInline(p, b.inline);
      return p;
    }
    case "h": {
      const h = document.createElement(b.level === 1 ? "h3" : "h4");
      appendInline(h, b.inline);
      return h;
    }
    case "ul":
    case "ol": {
      const list = document.createElement(b.t);
      for (const item of b.items) {
        const li = document.createElement("li");
        appendInline(li, item);
        list.appendChild(li);
      }
      return list;
    }
    case "hr":
      return document.createElement("hr");
    case "code":
      return codeBlock(b);
    default:
      return document.createTextNode("");
  }
}

function renderMarkdown(target, raw) {
  target.replaceChildren(...parseBlocks(raw).map(renderBlock));
}

// ---------- Hero: liquid folders (canvas only, from the studio design) ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeFbm(seed) {
  const r = mulberry32(seed);
  const p = [];
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  const perm = new Uint8Array(512);
  const grad = new Float32Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  for (let i = 0; i < 256; i++) {
    const ang = r() * Math.PI * 2;
    grad[i * 2] = Math.cos(ang);
    grad[i * 2 + 1] = Math.sin(ang);
  }
  const fade = (v) => v * v * (3 - 2 * v);
  const g = (h, dx, dy) => grad[h * 2] * dx + grad[h * 2 + 1] * dy;
  const n2 = (x0, y0) => {
    let X = Math.floor(x0),
      Y = Math.floor(y0);
    const x = x0 - X,
      y = y0 - Y;
    X &= 255;
    Y &= 255;
    const u = fade(x),
      v = fade(y);
    const aa = perm[perm[X] + Y],
      ba = perm[perm[X + 1] + Y];
    const ab = perm[perm[X] + Y + 1],
      bb = perm[perm[X + 1] + Y + 1];
    const l1 = g(aa, x, y) + u * (g(ba, x - 1, y) - g(aa, x, y));
    const l2 = g(ab, x, y - 1) + u * (g(bb, x - 1, y - 1) - g(ab, x, y - 1));
    return l1 + v * (l2 - l1);
  };
  return (x, y, oct) => {
    let sum = 0,
      amp = 0.5,
      fr = 1;
    for (let o = 0; o < oct; o++) {
      const c = Math.cos(o * 1.7),
        s = Math.sin(o * 1.7);
      sum += amp * n2(x * fr * c - y * fr * s, x * fr * s + y * fr * c);
      fr *= 2.03;
      amp *= 0.55;
    }
    return sum;
  };
}

function paintLiquid(canvas, seed, colors, scale, warp, gloss, veins) {
  const w = canvas.width,
    h = canvas.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const fbm = makeFbm(seed);
  const cols = colors.map((hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  });
  const s = (scale * 3.2) / Math.max(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x * s,
        py = y * s;
      const qx = fbm(px, py, 3),
        qy = fbm(px + 5.2, py + 1.3, 3);
      const rx = fbm(px + 4 * warp * qx + 1.7, py + 4 * warp * qy + 9.2, 3);
      const ry = fbm(px + 4 * warp * qx + 8.3, py + 4 * warp * qy + 2.8, 3);
      const f = fbm(px + 4 * warp * rx, py + 4 * warp * ry, 4);
      let v = Math.pow(Math.min(1, Math.max(0, f * 0.5 + 0.5)), 1.75);
      v = Math.min(0.999, v) * (cols.length - 1);
      const i0 = Math.floor(v),
        fv = v - i0;
      const c0 = cols[i0],
        c1 = cols[i0 + 1];
      let R = c0[0] + (c1[0] - c0[0]) * fv,
        G = c0[1] + (c1[1] - c0[1]) * fv,
        B = c0[2] + (c1[2] - c0[2]) * fv;
      const vein = Math.max(0, 1 - Math.abs(f) * (3.2 + veins * 4)) * veins;
      R -= vein * 46;
      G -= vein * 44;
      B -= vein * 40;
      const sp = Math.pow(Math.max(0, 1 - Math.abs(f + 0.35)), 6) * gloss;
      R += sp * 150;
      G += sp * 150;
      B += sp * 160;
      const o = (y * w + x) * 4;
      d[o] = R;
      d[o + 1] = G;
      d[o + 2] = B;
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

const ART_RECIPES = [
  {
    colors: [
      "#03040a",
      "#071026",
      "#0e2260",
      "#1e44c8",
      "#315ff2",
      "#6f97ff",
      "#a7c4ff",
    ],
    scale: 0.5,
    warp: 3.1,
    veins: 0.5,
    gloss: 0.38,
  },
  {
    colors: [
      "#03040a",
      "#0a1330",
      "#16307e",
      "#274fd4",
      "#4a79ff",
      "#8fb4ff",
      "#c9dbff",
    ],
    scale: 0.62,
    warp: 3.8,
    veins: 0.55,
    gloss: 0.4,
  },
];

function paintFolders() {
  const jobs = [];
  document.querySelectorAll(".gfolder").forEach((f, i) => {
    const back = f.querySelector(".gf-art");
    if (back && !back.dataset.done)
      jobs.push({
        c: back,
        r: ART_RECIPES[i % ART_RECIPES.length],
        seed: 17 + i * 97,
      });
  });
  const step = () => {
    const j = jobs.shift();
    if (!j) return;
    paintLiquid(
      j.c,
      j.seed,
      j.r.colors,
      j.r.scale,
      j.r.warp,
      j.r.gloss,
      j.r.veins,
    );
    j.c.dataset.done = "1";
    j.c.classList.add("ready");
    requestAnimationFrame(step);
  };
  step();
}

// ---------- History + skills (always from the server) ----------

async function fetchJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function syncFolderPreviews() {
  fetchJson("/api/sessions")
    .then((sessions) => {
      setTextIfPresent("#fhCount", `${sessions.length} proyek tersimpan`);
      setTextIfPresent(
        "#fhSheet1",
        sessions[0] ? shortText(sessions[0].title, 15) : "—",
      );
      setTextIfPresent(
        "#fhSheet2",
        sessions[1] ? shortText(sessions[1].title, 15) : "—",
      );
      renderRail(sessions);
    })
    .catch(() => {
      setTextIfPresent("#fhCount", "riwayat tak termuat");
    });
  fetchJson("/api/skills")
    .then((skills) => {
      setTextIfPresent("#fsCount", `${skills.length} skill aktif`);
      setTextIfPresent(
        "#fsSheet1",
        skills.length ? shortText(skills[skills.length - 1].name, 16) : "—",
      );
      setTextIfPresent(
        "#fsSheet2",
        skills[0] ? shortText(skills[0].name, 16) : "—",
      );
    })
    .catch(() => {
      setTextIfPresent("#fsCount", "skill tak termuat");
    });
}

function renderRail(sessions) {
  const list = $("#railList");
  if (!list) return;
  list.replaceChildren();
  if (!sessions.length) {
    const empty = document.createElement("div");
    empty.className = "rail-empty";
    empty.textContent = "Belum ada proyek. Riwayat akan muncul di sini.";
    list.appendChild(empty);
    return;
  }
  for (const sess of sessions) {
    const b = document.createElement("button");
    b.type = "button";
    b.className =
      "rail-item" + (sess.session_id === state.sessionId ? " active" : "");
    const title = document.createElement("b");
    title.textContent = shortText(sess.title, 34);
    const meta = document.createElement("small");
    meta.textContent =
      new Date(sess.updated_at).toLocaleDateString("id-ID", {
        day: "numeric",
        month: "short",
      }) + ` · v${sess.runs} · ${sess.prompts} perintah`;
    b.append(title, meta);
    b.addEventListener("click", () => void restoreSession(sess.session_id));
    list.appendChild(b);
  }
}

const folderSheet = $("#folderSheet");

function openFolderSheet(tabName) {
  folderSheet.hidden = false;
  switchFolderTab(tabName || "history");
}
function closeFolderSheet() {
  folderSheet.hidden = true;
  document
    .querySelectorAll(".gfolder.open")
    .forEach((f) => f.classList.remove("open"));
}
function switchFolderTab(tabName) {
  document.querySelectorAll(".stab").forEach((b) => {
    b.classList.toggle("active", b.dataset.ftab === tabName);
  });
  $("#tabHistory").hidden = tabName !== "history";
  $("#tabSkills").hidden = tabName !== "skills";
  $("#tabCheckpoints").hidden = tabName !== "checkpoints";
  $("#tabEvals").hidden = tabName !== "evals";
  if (tabName === "history") void renderSheetHistory();
  if (tabName === "skills") void renderSheetSkills();
  if (tabName === "checkpoints") void renderSheetCheckpoints();
  if (tabName === "evals") void renderSheetEvals();
  else stopEvalPoll();
}

function renderSheetHistory() {
  const box = $("#sheetHistList");
  box.replaceChildren();
  return fetchJson("/api/sessions")
    .then((list) => {
      if (!list.length) {
        const empty = document.createElement("div");
        empty.className = "exp-empty";
        empty.textContent =
          "Belum ada proyek di riwayat. Kirim perintah pertama untuk menyimpannya otomatis di sini.";
        box.appendChild(empty);
        return;
      }
      for (const sess of list) {
        const item = document.createElement("div");
        item.className = "exp-item";
        const mainEl = document.createElement("div");
        mainEl.className = "exp-main";
        const title = document.createElement("b");
        title.textContent = sess.title;
        const meta = document.createElement("small");
        meta.textContent =
          new Date(sess.updated_at).toLocaleDateString("id-ID", {
            day: "numeric",
            month: "short",
          }) + ` · v${sess.runs} · ${sess.prompts} perintah`;
        mainEl.append(title, meta);
        mainEl.addEventListener("click", () => {
          closeFolderSheet();
          void restoreSession(sess.session_id);
        });
        const dl = document.createElement("a");
        dl.className = "exp-del";
        dl.href = `/api/sessions/${sess.session_id}/download.zip`;
        dl.title = "Unduh proyek sebagai ZIP";
        dl.setAttribute("aria-label", "Unduh proyek sebagai ZIP");
        dl.innerHTML =
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>';
        const tr = document.createElement("a");
        tr.className = "exp-del";
        tr.href = `/api/sessions/${sess.session_id}/transcript`;
        tr.title = "Unduh transkrip percakapan (.md)";
        tr.setAttribute("aria-label", "Unduh transkrip percakapan (.md)");
        tr.innerHTML =
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>';
        const del = document.createElement("button");
        del.type = "button";
        del.className = "exp-del";
        del.title = "Hapus riwayat ini";
        del.setAttribute("aria-label", `Hapus riwayat ${sess.title}`);
        del.innerHTML =
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
        del.addEventListener("click", async () => {
          if (
            !confirm(
              `Hapus riwayat "${sess.title}"? Percakapan sesi ini ikut terhapus dari server. File proyek di workspace tetap ada.`,
            )
          )
            return;
          const r = await fetch(`/api/sessions/${sess.session_id}`, {
            method: "DELETE",
          });
          if (r.status === 409) {
            toast("Masih ada run yang berjalan di sesi ini.");
            return;
          }
          if (!r.ok) {
            toast("Gagal menghapus riwayat.");
            return;
          }
          if (state.sessionId === sess.session_id) resetSession();
          else void renderSheetHistory();
          toast("Riwayat dihapus.");
        });
        item.append(mainEl, dl, tr, del);
        box.appendChild(item);
      }
    })
    .catch(() => {
      const empty = document.createElement("div");
      empty.className = "exp-empty";
      empty.textContent = "Riwayat gagal dimuat dari server.";
      box.appendChild(empty);
    });
}

function renderSheetSkills() {
  const box = $("#sheetSkillList");
  box.replaceChildren();
  return fetchJson("/api/skills")
    .then((skills) => {
      if (!skills.length) {
        const empty = document.createElement("div");
        empty.className = "exp-empty";
        empty.textContent =
          "Belum ada skill. Tambah folder skills/<nama>/SKILL.md di repo, lalu restart server.";
        box.appendChild(empty);
        return;
      }
      for (const s of skills) {
        const row = document.createElement("div");
        row.className = "skill-item";
        const dot = document.createElement("span");
        dot.className = "skill-dot";
        const meta = document.createElement("div");
        meta.className = "skill-meta";
        const name = document.createElement("b");
        name.textContent = s.name;
        const desc = document.createElement("small");
        desc.textContent = s.description;
        meta.append(name, desc);
        const tag = document.createElement("span");
        tag.className = "skill-tag";
        tag.textContent = "repo";
        row.append(dot, meta, tag);
        box.appendChild(row);
      }
    })
    .catch(() => {
      const empty = document.createElement("div");
      empty.className = "exp-empty";
      empty.textContent = "Daftar skill gagal dimuat dari server.";
      box.appendChild(empty);
    });
}

$("#skillAddBtn").addEventListener("click", () => {
  const form = $("#skillForm");
  form.hidden = !form.hidden;
  if (!form.hidden) $("#skillUrlInput").focus();
});

$("#skillSaveBtn").addEventListener("click", async () => {
  const input = $("#skillUrlInput");
  const url = input.value.trim();
  if (!url) {
    toast("Tempel dulu link GitHub ke SKILL.md.");
    return;
  }
  const btn = $("#skillSaveBtn");
  btn.disabled = true;
  try {
    const r = await fetch("/api/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      toast(data.error ?? "Gagal menambah skill.");
      return;
    }
    toast(`Skill "${data.skill.name}" terpasang — tersedia di run berikutnya.`);
    input.value = "";
    $("#skillForm").hidden = true;
    void renderSheetSkills();
  } catch {
    toast("Gagal menambah skill.");
  } finally {
    btn.disabled = false;
  }
});

function renderSheetCheckpoints() {
  const box = $("#sheetCheckpointList");
  box.replaceChildren();
  return fetchJson("/api/checkpoints")
    .then((list) => {
      if (!list.length) {
        const empty = document.createElement("div");
        empty.className = "exp-empty";
        empty.textContent =
          "Belum ada checkpoint. Checkpoint dibuat otomatis di awal tiap run.";
        box.appendChild(empty);
        return;
      }
      for (const cp of list) {
        const item = document.createElement("div");
        item.className = "exp-item";
        const mainEl = document.createElement("div");
        mainEl.className = "exp-main";
        const title = document.createElement("b");
        title.textContent = cp.id;
        const meta = document.createElement("small");
        meta.textContent =
          new Date(cp.created_at).toLocaleString("id-ID", {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          }) + ` · ${cp.method} · ${cp.files.length} file`;
        mainEl.append(title, meta);
        const restore = document.createElement("button");
        restore.type = "button";
        restore.className = "cp-restore";
        restore.textContent = "Pulihkan";
        restore.addEventListener("click", async () => {
          if (
            !window.confirm(
              `Pulihkan workspace ke checkpoint ${cp.id}?\nFile yang dibuat setelah checkpoint akan dihapus, file yang diubah kembali ke isi saat checkpoint dibuat.`,
            )
          )
            return;
          restore.disabled = true;
          try {
            const r = await fetch(`/api/checkpoints/${cp.id}/restore`, {
              method: "POST",
            });
            if (!r.ok) throw new Error("gagal");
            const data = await r.json();
            toast(
              `Checkpoint dipulihkan (${data.files_restored} file) — kirim perintah baru untuk melanjutkan.`,
            );
          } catch {
            toast("Gagal memulihkan checkpoint.");
            restore.disabled = false;
          }
        });
        item.append(mainEl, restore);
        box.appendChild(item);
      }
    })
    .catch(() => {
      const empty = document.createElement("div");
      empty.className = "exp-empty";
      empty.textContent = "Daftar checkpoint gagal dimuat dari server.";
      box.appendChild(empty);
    });
}

// ---------- Eval tab (Fitur 3) ----------
let evalPoll = null;
function stopEvalPoll() {
  if (evalPoll) {
    clearInterval(evalPoll);
    evalPoll = null;
  }
}

function evalStatusLabel(status) {
  return status === "running"
    ? "Berjalan"
    : status === "done"
      ? "Selesai"
      : "Gagal";
}

function renderSheetEvals() {
  const box = $("#evalList");
  box.replaceChildren();
  stopEvalPoll();
  return fetchJson("/api/evals")
    .then((data) => {
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      const evals = Array.isArray(data.evals) ? data.evals : [];
      // Provider select: nama provider dari /api/config (bukan id model —
      // scripts/eval.ts mencari provider berdasarkan nama).
      const providers =
        Array.isArray(state.cfg?.providers) && state.cfg.providers.length
          ? state.cfg.providers
          : [];
      const sel = $("#evalModelSelect");
      sel.replaceChildren();
      if (!providers.length) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "Belum ada provider";
        sel.appendChild(opt);
      } else {
        for (const name of providers) {
          const opt = document.createElement("option");
          opt.value = name;
          opt.textContent = name;
          sel.appendChild(opt);
        }
        if (state.evalModel && providers.includes(state.evalModel))
          sel.value = state.evalModel;
      }
      sel.onchange = () => {
        state.evalModel = sel.value;
      };
      // Task checkboxes: centang semua secara default; kosongkan semua
      // untuk menjalankan semua tugas.
      if (!state.evalSelected)
        state.evalSelected = new Set(tasks.map((t) => t.id));
      const taskBox = $("#evalTaskList");
      taskBox.replaceChildren();
      for (const t of tasks) {
        const row = document.createElement("label");
        row.className = "skill-item";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = state.evalSelected.has(t.id);
        cb.addEventListener("change", () => {
          if (cb.checked) state.evalSelected.add(t.id);
          else state.evalSelected.delete(t.id);
        });
        const meta = document.createElement("div");
        meta.className = "skill-meta";
        const name = document.createElement("b");
        name.textContent = t.id;
        const desc = document.createElement("small");
        desc.textContent = t.title;
        meta.append(name, desc);
        const tag = document.createElement("span");
        tag.className = "skill-tag";
        tag.textContent = t.category;
        row.append(cb, meta, tag);
        taskBox.appendChild(row);
      }
      if (!evals.length) {
        const empty = document.createElement("div");
        empty.className = "exp-empty";
        empty.textContent =
          "Belum ada eval. Pilih provider dan tugas, lalu jalankan.";
        box.appendChild(empty);
      }
      for (const ev of evals) {
        const item = document.createElement("div");
        item.className = "exp-item";
        const mainEl = document.createElement("div");
        mainEl.className = "exp-main";
        const title = document.createElement("b");
        title.textContent = `${ev.model} · ${ev.tasks.length} tugas`;
        const meta = document.createElement("small");
        const started = new Date(ev.startedAt).toLocaleString("id-ID", {
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        });
        const dur = ev.finishedAt
          ? ` · ${Math.round((ev.finishedAt - ev.startedAt) / 1000)} dtk`
          : "";
        meta.textContent = `${started}${dur} · ${ev.id}`;
        mainEl.append(title, meta);
        const tag = document.createElement("span");
        tag.className = "skill-tag";
        tag.textContent = evalStatusLabel(ev.status);
        const logBtn = document.createElement("button");
        logBtn.type = "button";
        logBtn.className = "cp-restore";
        logBtn.textContent = "Log";
        logBtn.addEventListener("click", () => void toggleEvalLog(item, ev.id));
        item.append(mainEl, tag, logBtn);
        box.appendChild(item);
        if (state.evalOpenLog === ev.id) void toggleEvalLog(item, ev.id, true);
      }
      // Selama ada eval berjalan, segarkan daftar tiap 10 detik selagi
      // tab ini terbuka — satu batch bisa 10-25 menit.
      if (evals.some((ev) => ev.status === "running")) {
        evalPoll = setInterval(() => {
          if (!$("#tabEvals").hidden) void renderSheetEvals();
          else stopEvalPoll();
        }, 10_000);
      }
    })
    .catch(() => {
      const empty = document.createElement("div");
      empty.className = "exp-empty";
      empty.textContent = "Daftar eval gagal dimuat dari server.";
      box.appendChild(empty);
    });
}

async function toggleEvalLog(item, evalId, reopen = false) {
  const old = item.querySelector(".eval-log-wrap");
  if (old && !reopen) {
    old.remove();
    if (state.evalOpenLog === evalId) state.evalOpenLog = null;
    return;
  }
  if (old) old.remove();
  state.evalOpenLog = evalId;
  const wrap = document.createElement("div");
  wrap.className = "eval-log-wrap";
  const pre = document.createElement("pre");
  pre.className = "eval-log";
  pre.textContent = "Memuat log…";
  wrap.appendChild(pre);
  item.appendChild(wrap);
  try {
    const data = await fetchJson(`/api/evals/${evalId}`);
    pre.textContent = data.log || "(log masih kosong)";
  } catch {
    pre.textContent = "Log gagal dimuat.";
  }
}

$("#evalRunBtn").addEventListener("click", async () => {
  const model = $("#evalModelSelect").value;
  if (!model) {
    toast("Belum ada provider — isi .env dulu.");
    return;
  }
  const tasks = state.evalSelected ? [...state.evalSelected] : [];
  const btn = $("#evalRunBtn");
  btn.disabled = true;
  try {
    const r = await fetch("/api/evals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, tasks }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 409) {
      toast("Masih ada eval yang berjalan — tunggu sampai selesai.");
      return;
    }
    if (!r.ok) {
      toast(data.error ?? "Gagal menjalankan eval.");
      return;
    }
    toast(`Eval dimulai (${data.eval.model}, ${data.eval.tasks.length} tugas).`);
    void renderSheetEvals();
  } catch {
    toast("Gagal menjalankan eval.");
  } finally {
    btn.disabled = false;
  }
});

function bindHero() {
  // The design stores per-sheet CSS variables inline; CSP forbids inline style, so set them here.
  document.querySelectorAll(".gf-sheet").forEach((s) => {
    s.style.setProperty("--s", s.dataset.s || "0");
    s.style.setProperty("--jr", s.dataset.jr || "0deg");
  });
  const openWithFan = (btn, tab) => {
    btn.classList.add("open");
    setTimeout(() => openFolderSheet(tab), reducedMotion ? 40 : 300);
  };
  $("#folderHistoryBtn").addEventListener("click", () =>
    openWithFan($("#folderHistoryBtn"), "history"),
  );
  $("#folderSkillsBtn").addEventListener("click", () =>
    openWithFan($("#folderSkillsBtn"), "skills"),
  );
  if (matchMedia("(hover:hover)").matches) {
    document.querySelectorAll(".gfolder").forEach((f) => {
      f.addEventListener("pointermove", (e) => {
        const r = f.getBoundingClientRect();
        f.style.setProperty(
          "--px",
          (((e.clientX - r.left) / r.width) * 2 - 1).toFixed(3),
        );
        f.style.setProperty(
          "--py",
          (((e.clientY - r.top) / r.height) * 2 - 1).toFixed(3),
        );
      });
      f.addEventListener("pointerleave", () => {
        f.style.setProperty("--px", "0");
        f.style.setProperty("--py", "0");
      });
    });
  }
  document.querySelectorAll(".sug").forEach((s) => {
    s.addEventListener("click", () => {
      if (!ownRunId()) void start(s.dataset.prompt || "");
    });
  });
  paintFolders();
}

// ---------- Revision bar ----------

function updateRevBar() {
  const bar = $("#revBar");
  const current = state.versions[state.activeVersion];
  if (!current || !state.sessionId || state.revDismissed) {
    bar.hidden = true;
    input.placeholder = "Tulis perintah atau ide halaman web...";
    return;
  }
  $("#revBarText").textContent =
    "Merevisi: " +
    shortText(current.title, 26) +
    " · v" +
    (state.activeVersion + 1);
  input.placeholder =
    "Tulis revisi untuk " + shortText(current.title, 24) + "...";
  bar.hidden = false;
}

$("#revDismissBtn").addEventListener("click", () => {
  state.revDismissed = true;
  updateRevBar();
});
$("#revNewBtn").addEventListener("click", () => resetSession());

// ---------- Model pill + effort (from /api/config, never hardcoded) ----------

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem("bikinin.prefs") || "{}");
    if (p.effort === "sedang" || p.effort === "tinggi")
      state.curEffort = p.effort;
    return p;
  } catch {
    return {};
  }
}
function savePrefs() {
  try {
    localStorage.setItem(
      "bikinin.prefs",
      JSON.stringify({ model: state.curModel, effort: state.curEffort }),
    );
  } catch {
    // Preferences are best-effort; the app works without them.
  }
}

function updateModelLabel() {
  const effortLabel = state.curEffort === "tinggi" ? "Tinggi" : "Sedang";
  $("#modelLabel").textContent = state.curModel
    ? `${state.curModel} · ${effortLabel}`
    : "memuat…";
  document.querySelectorAll("#effortSeg button").forEach((b) => {
    b.classList.toggle("sel", b.dataset.effort === state.curEffort);
  });
}

function renderModelList() {
  // Dropdown native (<select>), bukan daftar tombol: 16 model tidak
  // memenuhi popover; di HP Safari, ketuk select membuka pemilih bawaan.
  const sel = $("#modelSelect");
  sel.replaceChildren();
  if (!state.models.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Tidak ada model dari server.";
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const [i, m] of state.models.entries()) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = i === 0 ? `${m} (utama)` : m;
    sel.appendChild(opt);
  }
  if (state.curModel && state.models.includes(state.curModel))
    sel.value = state.curModel;
}

function closePops() {
  $("#modelPop").hidden = true;
  $("#statPop").hidden = true;
}

$("#modelBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  const open = $("#modelPop").hidden;
  closePops();
  $("#modelPop").hidden = !open;
  $("#modelBtn").setAttribute("aria-expanded", String(open));
});
$("#modelSelect").addEventListener("change", () => {
  state.curModel = $("#modelSelect").value;
  savePrefs();
  updateModelLabel();
  closePops();
});
$("#ringBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  const open = $("#statPop").hidden;
  closePops();
  $("#statPop").hidden = !open;
});
document.querySelectorAll("#effortSeg button").forEach((b) => {
  b.addEventListener("click", () => {
    state.curEffort = b.dataset.effort;
    savePrefs();
    updateModelLabel();
    closePops();
  });
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#modelPop,#modelBtn,#statPop,#ringBtn")) closePops();
});

$("#enhanceBtn").addEventListener("click", () => {
  const raw = input.value.trim();
  // Jangan sisipkan template apa pun: template landing page yang lama
  // tidak cocok dengan isi chat (mis. pertanyaan soal cloning suara).
  // Tombol ini hanya memperjelas perintah yang sudah ditulis pengguna.
  if (!raw) {
    toast("Tulis perintah dulu, baru ketuk ini untuk memperjelas.");
    return;
  }
  if (raw.length < 70) {
    input.value =
      raw +
      " — kerjakan dengan teliti sampai selesai, dan jelaskan singkat hasilnya.";
  } else {
    toast("Prompt sudah cukup detail");
    return;
  }
  input.dispatchEvent(new Event("input"));
  input.focus();
  toast("Prompt diperjelas otomatis");
});

// ---------- Lampiran file (POST /api/uploads, maks 6 file, 10 MB/file) ----------

const MAX_ATTACH_FILES = 6;
const MAX_ATTACH_BYTES = 10 * 1024 * 1024;

function fmtAttachBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function renderAttachments() {
  const row = $("#attachRow");
  row.replaceChildren();
  row.hidden = state.pendingFiles.length === 0;
  state.pendingFiles.forEach((file, i) => {
    const chip = document.createElement("span");
    chip.className = "attach-chip";
    const label = document.createElement("span");
    label.textContent = `${file.name} · ${fmtAttachBytes(file.size)}`;
    const x = document.createElement("button");
    x.type = "button";
    x.className = "attach-x";
    x.textContent = "×";
    x.setAttribute("aria-label", `Hapus ${file.name}`);
    x.addEventListener("click", () => {
      state.pendingFiles.splice(i, 1);
      renderAttachments();
    });
    chip.append(label, x);
    row.appendChild(chip);
  });
}

$("#plusBtn").addEventListener("click", () => $("#fileInput").click());

$("#fileInput").addEventListener("change", () => {
  const picked = [...$("#fileInput").files];
  $("#fileInput").value = "";
  for (const file of picked) {
    if (state.pendingFiles.length >= MAX_ATTACH_FILES) {
      toast(`Maksimal ${MAX_ATTACH_FILES} file per pesan.`);
      break;
    }
    if (file.size > MAX_ATTACH_BYTES) {
      toast(`${file.name} melebihi batas 10 MB.`);
      continue;
    }
    if (file.size === 0) {
      toast(`${file.name} kosong.`);
      continue;
    }
    state.pendingFiles.push(file);
  }
  renderAttachments();
});

/** Uploads pending files first; returns their workspace paths. */
async function uploadPendingFiles() {
  const form = new FormData();
  for (const file of state.pendingFiles) form.append("file", file);
  const r = await fetch("/api/uploads", { method: "POST", body: form });
  if (!r.ok) {
    let detail = "";
    try {
      const b = await r.json();
      if (b && typeof b.error === "string") detail = b.error;
    } catch {
      // fall back to the status below
    }
    throw new Error(detail || `Upload gagal (${r.status}).`);
  }
  const data = await r.json();
  return (data.uploads ?? []).map((u) => u.path);
}

// ---------- Messages ----------

function addUser(text) {
  const div = document.createElement("div");
  div.className = "msg user";
  div.textContent = text;
  main.appendChild(div);
  scrollDown(true);
}

function addThink(label) {
  const block = tpl("#tplThink");
  const labelEl = block.querySelector(".think-label");
  const timer = block.querySelector(".think-timer-pill");
  labelEl.textContent = label;
  const toggle = block.querySelector(".think-toggle");
  toggle.addEventListener("click", () => {
    const collapsed = block.classList.toggle("collapsed");
    toggle.setAttribute("aria-expanded", String(!collapsed));
  });
  // Ketuk label saat run menunggu izin -> buka lembar persetujuan yang
  // tertunda (lembar itu TIDAK dibuka otomatis saat pindah/refresh chat).
  labelEl.addEventListener("click", () => {
    if (state.pendingApproval) {
      openApproval(state.pendingApproval.req, state.pendingApproval.runId);
    }
  });
  // Kayak Z.ai (tampilan saat kerja BARU dikasih, bukan saat selesai):
  // blok mulai terlipat — yang kelihatan saat run jalan cuma satu baris
  // (langkah terakhir + timer). Detail langkah + panel kode ada di
  // drawer, ketuk header untuk membuka. Sebelumnya blok kebuka penuh
  // selama run, jadi layar penuh baris langkah.
  block.classList.add("collapsed");
  toggle.setAttribute("aria-expanded", "false");
  main.appendChild(block);
  scrollDown(true);
  state.startedAt = Date.now();
  clearInterval(state.timerInt);
  state.timerInt = setInterval(() => {
    timer.textContent =
      ((Date.now() - state.startedAt) / 1000).toFixed(1) + "s";
    // Perkiraan selesai ikut bergerak seiring waktu (bukan cuma saat ada
    // langkah baru) — kalau satu langkah lama, angkanya naik juga.
    updateThinkHeader();
  }, 100);
  state.think = {
    block,
    labelEl,
    timer,
    drawer: block.querySelector(".think-drawer"),
    linesEl: block.querySelector(".think-lines"),
    codeLive: block.querySelector(".code-live"),
    codeLivePath: block.querySelector(".code-live-path"),
    codeLiveBody: block.querySelector(".code-live-body"),
    rows: new Map(),
    files: new Set(), // path file yang disentuh run ini (untuk hitungan header)
    count: 0,
  };
  // Drawer mulai kosong (belum ada langkah/kode) — jangan tampil sebagai
  // kotak kosong; begitu ada isi, kelasnya dilepas di thinkLine/showCode.
  state.think.drawer.classList.add("empty");
}

/** Tampilkan kode asli terbaru di panel think (diff file / output tool).
 *  Panel hanya muncul bila ada konten nyata — tidak ada placeholder. */
function showCode(title, body) {
  const t = state.think;
  if (!t || !t.codeLive || !body) return;
  if (t.drawer) t.drawer.classList.remove("empty");
  t.codeLivePath.textContent = title;
  // Panel hanya cuplikan pendek (bukan dinding teks): cukup untuk melihat
  // apa yang sedang dikerjakan, tanpa memenuhi layar.
  t.codeLiveBody.textContent = capText(body, 600);
  t.codeLive.hidden = false;
  t.codeLiveBody.scrollTop = t.codeLiveBody.scrollHeight;
  scrollDown();
}

/** Potong teks ke batas aman panel HP (tanpa mengubah isinya bila pendek). */
function capText(s, max) {
  const text = String(s ?? "");
  return text.length > max ? text.slice(0, max) + "…" : text;
}

const PLAN_MARKS = { done: "✓", doing: "›", pending: "○" };

/** Rencana sebagai teks baris-per-langkah (tanda status sama seperti panel Todo). */
function formatPlan(items) {
  if (!Array.isArray(items) || items.length === 0) return "";
  const lines = items.map(
    (it) => `${PLAN_MARKS[it.status] || "○"} ${it.text}`,
  );
  return capText(lines.join("\n"), 2000);
}

/** Argumen tool_call_started sebagai teks ringkas untuk panel.
 *  update_plan diformat sebagai rencana (bukan JSON mentah); nilai argumen
 *  dipotong per nilai (maks 300 karakter) dan total maks 1500 karakter.
 *  Argumen di event sudah diredaksi server (tanpa rahasia, tanpa isi file). */
function formatToolCall(tool, args) {
  if (!args || typeof args !== "object") return "";
  if (tool === "update_plan" && Array.isArray(args.items)) {
    return formatPlan(args.items);
  }
  const lines = [];
  for (const [key, value] of Object.entries(args)) {
    const text =
      typeof value === "string" ? value : JSON.stringify(value) ?? "";
    lines.push(`${key}: ${capText(text, 300)}`);
  }
  return capText(lines.join("\n"), 1500);
}

/** Baris kode pertama yang bermakna dari sebuah teks (lewati baris kosong
 *  dan header diff) — untuk cuplikan satu baris di bawah label langkah. */
function firstCodeLine(text) {
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (
      line.startsWith("@@") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("diff ")
    ) continue;
    return line;
  }
  return "";
}

/** Isi cuplikan kode satu baris di bawah label langkah (tampil, tapi
 *  simpel: kecil, meredup, terpotong satu baris dengan …). */
function setStepCode(row, text) {
  if (!row || !row.snippet) return;
  const first = firstCodeLine(text);
  if (!first) return;
  row.snippet.textContent = capText(first, 140);
  row.snippet.hidden = false;
}

function thinkLine(callId, text) {
  const t = state.think;
  if (!t) return;
  const short = capText(text, 120);
  const line = document.createElement("div");
  line.className = "think-line";
  const label = document.createElement("span");
  label.className = "think-line-text";
  label.textContent = short;
  const snippet = document.createElement("div");
  snippet.className = "think-snippet";
  snippet.hidden = true;
  line.append(label, snippet);
  t.linesEl.appendChild(line);
  t.rows.set(callId, { line, label, text: short, snippet });
  t.count += 1;
  // Hitung file yang disentuh (kayak Z.ai "Explored N files"): label
  // langkah file selalu "read_file/write_file/edit_file <path>".
  const [tool, ...rest] = short.split(" ");
  if (
    (tool === "read_file" || tool === "write_file" || tool === "edit_file") &&
    rest.length > 0
  ) {
    t.files.add(rest.join(" "));
  }
  if (t.drawer) t.drawer.classList.remove("empty");
  updateThinkHeader();
  scrollDown();
}

/** Header blok proses kayak Z.ai ("Explored N files, Ran N commands"):
 * begitu ada langkah, label jadi hitungan file + perintah, diawali kata
 * "Bekerja" supaya status jalan vs selesai langsung kelihatan dalam
 * satu baris — sebelumnya label cuma hitungan, jadi mirip ringkasan
 * selesai. Sebelum langkah pertama, label tetap "Menyusun rencana…".
 * Perkiraan selesai (±N mnt, dari kecepatan rencana) tampil di depan
 * hitungan supaya tidak kepotong ellipsis di layar sempit. */
function updateThinkHeader() {
  const t = state.think;
  if (!t || t.count === 0) return;
  // Run menunggu izin: labelnya bilang begitu (bukan "Bekerja") supaya
  // pengguna tahu kenapa run diam — ketuk label untuk membuka lembar izin.
  if (state.pendingApproval) {
    t.labelEl.textContent = "Menunggu izin · ketuk untuk menjawab";
    return;
  }
  const eta = computeEtaMin();
  t.labelEl.textContent =
    "Bekerja · " +
    (eta === null ? "" : `±${eta} mnt · `) +
    `${t.files.size} file · ${t.count} perintah`;
}

/** Perkiraan menit sampai run selesai, dari kecepatan rencana: waktu yang
 *  sudah jalan dibagi langkah rencana yang selesai, dikali langkah yang
 *  tersisa. Null bila belum ada dasarnya (rencana belum ada / belum ada
 *  langkah selesai / rencana sudah habis) — jangan mengarang angka.
 *  Bukan janji: model gratis kadang melambat, jadi labelnya pakai ±. */
function computeEtaMin() {
  const items = state.planItems;
  if (!Array.isArray(items) || items.length === 0) return null;
  if (!state.startedAt) return null;
  const done = items.filter((it) => it.status === "done").length;
  if (done === 0) return null;
  const remaining = items.length - done;
  if (remaining <= 0) return null;
  const elapsed = (Date.now() - state.startedAt) / 1000;
  return Math.max(1, Math.round(((elapsed / done) * remaining) / 60));
}

function finishThink(status, steps) {
  clearInterval(state.timerInt);
  state.pendingApproval = null;
  const t = state.think;
  if (!t) return;
  t.timer.textContent =
    ((Date.now() - state.startedAt) / 1000).toFixed(1) + "s";
  t.labelEl.classList.remove("shimmer");
  if (t.count === 0) {
    t.block.remove(); // a plain chat answer needs no "steps" block
  } else {
    const labels = {
      completed: `Selesai ✓ · ${steps} langkah`,
      stopped: "Dihentikan pengguna",
      budget_exceeded: "Berhenti: batas tercapai",
      error: "Berhenti karena error",
    };
    t.labelEl.textContent = labels[status] || "Selesai";
    t.block.classList.add(status === "error" ? "err" : "done");
    // Kayak Z.ai: begitu run berakhir (status apa pun — selesai,
    // dihentikan, error, batas tercapai), lipat jadi satu baris
    // ringkasan. Detail langkah + kode tetap ada, tinggal ketuk header
    // untuk membuka; sebelumnya cuma status "completed" yang dilipat,
    // jadi run yang putus di tengah membiarkan daftar langkah memenuhi
    // layar selamanya.
    t.block.classList.add("collapsed");
    const toggle = t.block.querySelector(".think-toggle");
    if (toggle) toggle.setAttribute("aria-expanded", "false");
  }
  state.lastThink = t.count === 0 ? null : t.block;
  state.think = null;
}

// ---------- Fase 5: Todo panel (plan_updated) ----------

function renderPlan(items) {
  state.planItems = items;
  let panel = state.planEl;
  if (!panel) {
    panel = document.createElement("div");
    panel.className = "plan-panel";
    const head = document.createElement("div");
    head.className = "plan-head";
    head.textContent = "Rencana";
    panel.appendChild(head);
    const list = document.createElement("ul");
    list.className = "plan-list";
    panel.appendChild(list);
    state.planEl = panel;
    main.prepend(panel);
  }
  const list = panel.querySelector(".plan-list");
  list.replaceChildren();
  for (const it of items) {
    const li = document.createElement("li");
    li.className = "plan-item " + it.status;
    const mark = document.createElement("span");
    mark.className = "plan-mark";
    mark.textContent =
      it.status === "done" ? "✓" : it.status === "doing" ? "›" : "○";
    const tx = document.createElement("span");
    tx.textContent = it.text;
    li.append(mark, tx);
    list.appendChild(li);
  }
  scrollDown();
}

// ---------- Fase 5: input suara (Web Speech API, tanpa key) ----------

function setupVoice() {
  const btn = $("#micBtn");
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    btn.hidden = true;
    return;
  }
  let rec = null;
  let listening = false;
  btn.addEventListener("click", () => {
    if (listening) {
      rec?.stop();
      return;
    }
    rec = new SR();
    rec.lang = "id-ID";
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let finalText = "";
    rec.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      const base = input.dataset.base ?? "";
      input.value = (base + finalText + interim).trimStart();
      autoGrow();
      updateSendState();
    };
    const stop = () => {
      listening = false;
      btn.classList.remove("listening");
      btn.setAttribute("aria-label", "Input suara");
      delete input.dataset.base;
      updateSendState();
    };
    rec.onstart = () => {
      listening = true;
      btn.classList.add("listening");
      btn.setAttribute("aria-label", "Berhenti merekam");
      input.dataset.base = input.value ? input.value + " " : "";
    };
    rec.onend = stop;
    rec.onerror = () => {
      stop();
      toast("Input suara gagal — coba lagi atau ketik manual.");
    };
    try {
      rec.start();
    } catch {
      stop();
    }
  });
}

function explainBox() {
  if (!state.explainEl) {
    const box = document.createElement("div");
    box.className = "agent-explain";
    main.appendChild(box);
    state.explainEl = box;
    state.explainRaw = "";
  }
  return state.explainEl;
}

function addErrorCard(title, message, options = {}) {
  const card = tpl("#tplError");
  card.querySelector("b").textContent = title;
  card.querySelector("small").textContent = message;
  const retry = card.querySelector(".retry-btn");
  retry.hidden = options.retry === false;
  retry.addEventListener("click", () => {
    card.remove();
    if (state.errorCard === card) state.errorCard = null;
    if (!ownRunId() && state.lastPrompt) void start(state.lastPrompt);
  });
  const switchModel = card.querySelector(".switch-model-btn");
  switchModel.hidden = !options.switchModel || state.models.length < 2;
  switchModel.addEventListener("click", () => {
    card.remove();
    if (state.errorCard === card) state.errorCard = null;
    if ($("#modelPop").hidden) $("#modelBtn").click();
  });
  main.appendChild(card);
  state.errorCard = card;
  scrollDown(true);
}

function showRunError(message) {
  const text = String(message ?? "");
  const lower = text.toLowerCase();
  if (/\b429\b|rate.?limit|quota/.test(lower)) {
    addErrorCard(
      "Kuota atau rate limit provider tercapai",
      `${text} Pilih model lain, atau coba lagi setelah kuota tersedia.`,
      { retry: true, switchModel: true },
    );
    return;
  }
  if (/\b400\b|invalid_argument|menolak request/.test(lower)) {
    addErrorCard(
      "Provider menolak format permintaan (400)",
      `${text} Mengulang model yang sama biasanya tidak membantu; coba pilih model lain.`,
      { retry: false, switchModel: true },
    );
    return;
  }
  addErrorCard("Agent mengalami masalah", text, { retry: true });
}

// ---------- Fase 6: verification card + diff review ----------

function renderVerification(e) {
  const card = document.createElement("div");
  card.className = "verify-card " + (e.outcome === "pass" ? "pass" : "fail");
  const title = document.createElement("b");
  title.textContent =
    e.outcome === "pass"
      ? "✓ Verifikasi sendiri lolos"
      : `✗ Verifikasi sendiri menemukan masalah (perbaikan ${e.fixes}/2)`;
  card.appendChild(title);
  const list = document.createElement("ul");
  for (const c of e.checks || []) {
    const li = document.createElement("li");
    li.textContent = `${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`;
    list.appendChild(li);
  }
  card.appendChild(list);
  main.appendChild(card);
  scrollDown(true);
}

function renderDiffs() {
  for (const [path, info] of state.files) {
    if (!info.diff) continue;
    const details = document.createElement("details");
    details.className = "diff-block";
    const summary = document.createElement("summary");
    summary.textContent = `Diff: ${path}`;
    details.appendChild(summary);
    const pre = document.createElement("pre");
    pre.textContent = info.diff;
    details.appendChild(pre);
    main.appendChild(details);
  }
  if ([...state.files.values()].some((f) => f.diff)) scrollDown(true);
}

// ---------- Result card + versions ----------

const previewUrl = (path, bust = false) =>
  "/preview/" +
  path.split("/").map(encodeURIComponent).join("/") +
  (bust ? "?t=" + Date.now() : "");

function fitThumb(wrap, iframe) {
  const w = wrap.clientWidth || 580;
  const scale = w / 1024;
  iframe.style.transform = `scale(${scale.toFixed(4)})`;
  wrap.style.height =
    Math.max(150, Math.min(320, Math.round(560 * scale))) + "px";
}

async function fetchText(path) {
  const r = await fetch(previewUrl(path, true));
  if (!r.ok) throw new Error("gagal memuat file");
  return r.text();
}

async function downloadBlob(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

async function downloadFile(version) {
  try {
    const text = version.content ?? (await fetchText(version.path));
    await downloadBlob(
      text,
      version.path.split("/").pop() || "index.html",
      "text/html",
    );
    toast(`${version.path.split("/").pop() || "index.html"} diunduh`);
  } catch {
    toast("Gagal mengunduh file");
  }
}

function setFrameSource(frame, version) {
  if (version.content != null) {
    frame.removeAttribute("src");
    frame.srcdoc = version.content;
  } else {
    frame.removeAttribute("srcdoc");
    frame.src = previewUrl(version.path, true);
  }
}

function renderResultCard() {
  if (!state.versions.length) return;
  const active = state.versions[state.activeVersion];
  const card = tpl("#tplResult");
  const wrap = card.querySelector(".thumb-wrap");
  const frame = card.querySelector(".thumb-frame");
  card.querySelector(".res-title").textContent = active.title;
  card.querySelector(".res-sub").textContent =
    `${active.path} · ` + fmtKb(active.bytes);
  card.querySelector(".thumb-badge").textContent =
    "Live · v" + (state.activeVersion + 1);
  setFrameSource(frame, active);
  const pills = card.querySelector(".ver-pills");
  if (state.versions.length > 1) {
    state.versions.forEach((v, idx) => {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className =
        "ver-pill" + (idx === state.activeVersion ? " active" : "");
      pill.textContent = "v" + (idx + 1);
      pill.addEventListener("click", () => {
        state.activeVersion = idx;
        renderResultCard();
        updateRevBar();
        toast("Beralih ke versi v" + (idx + 1));
      });
      pills.appendChild(pill);
    });
  }
  if (state.resultCard) state.resultCard.replaceWith(card);
  else main.appendChild(card);
  state.resultCard = card;
  fitThumb(wrap, frame);
  if (window.ResizeObserver)
    new ResizeObserver(() => fitThumb(wrap, frame)).observe(wrap);
  const open = (mode) => openOverlay(state.versions[state.activeVersion], mode);
  wrap.addEventListener("click", () => open("preview"));
  card
    .querySelector('[data-act="preview"]')
    .addEventListener("click", () => open("preview"));
  card
    .querySelector('[data-act="code"]')
    .addEventListener("click", () => open("code"));
  card
    .querySelector('[data-act="download"]')
    .addEventListener(
      "click",
      () => void downloadFile(state.versions[state.activeVersion]),
    );
  card.querySelector('[data-act="regen"]').addEventListener("click", () => {
    if (!ownRunId() && state.lastPrompt) void start(state.lastPrompt);
  });
  scrollDown(true);
}

// ---------- Overlay: preview + code ----------

function highlightSyntax(rawCode) {
  // Escape first, then wrap tokens — the output can only contain spans + escaped text.
  const escaped = escHtml(rawCode);
  const tokenRe =
    /(&lt;!--[\s\S]*?--&gt;|\/\*[\s\S]*?\*\/|(?<![:\/])\/\/[^\n]*)|(&quot;(?:\\.|(?!&quot;)[^\\\n])*&quot;|'(?:\\.|[^'\\\n])*')|(&lt;\/?)([a-zA-Z0-9-]+)|(\/?&gt;)|(#[0-9a-fA-F]{3,8}\b)|\b([a-z-]+)(?=\s*:)|\b(const|let|var|function|return|if|else|for|while|new|document|window|true|false|null|doctype|html)\b|\b(\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%|s|ms|deg)?)\b/g;
  return escaped.replace(
    tokenRe,
    (match, com, str, tagOpen, tagName, tagClose, hex, prop, kw, num) => {
      if (com) return '<span class="tok-com">' + com + "</span>";
      if (str) return '<span class="tok-str">' + str + "</span>";
      if (tagOpen)
        return (
          '<span class="tok-punc">' +
          tagOpen +
          '</span><span class="tok-tag">' +
          tagName +
          "</span>"
        );
      if (tagClose) return '<span class="tok-punc">' + tagClose + "</span>";
      if (hex) return '<span class="tok-num">' + hex + "</span>";
      if (prop) return '<span class="tok-prop">' + prop + "</span>";
      if (kw) return '<span class="tok-kw">' + kw + "</span>";
      if (num) return '<span class="tok-num">' + num + "</span>";
      return match;
    },
  );
}

function setOverlayMode(mode) {
  document
    .querySelectorAll(".ov-mode")
    .forEach((b) => b.classList.toggle("active", b.dataset.ov === mode));
  const isCode = mode === "code";
  const mobile = $("#ovStage").classList.contains("mobile-vp");
  $("#ovStage").hidden = isCode;
  $("#ovCode").hidden = !isCode;
  $("#ovVp").hidden = isCode;
  $("#ovRefreshBtn").hidden = isCode;
  $("#vpBadge").hidden = isCode || !mobile;
  if (isCode) void renderCode();
}

async function renderCode() {
  const version = state.overlayVersion;
  if (!version) return;
  let files = state.overlayFiles;
  if (!files.length && state.sessionId) {
    try {
      files = await fetchJson(`/api/sessions/${state.sessionId}/files`);
      state.overlayFiles = files;
    } catch {
      files = [];
    }
  }
  if (!files.length) files = [{ path: version.path, bytes: version.bytes }];
  const viewable = files
    .filter((f) =>
      /\.(html?|css|js|mjs|json|md|txt|svg|mp4|webm|mov)$/i.test(f.path),
    )
    .slice(0, 12);
  if (!viewable.length)
    viewable.push({ path: version.path, bytes: version.bytes });
  state.overlayFileIdx = Math.max(
    0,
    viewable.findIndex((f) => f.path === version.path),
  );
  const tabs = $("#ovFtabs");
  tabs.replaceChildren();
  let lastDir = null;
  viewable.forEach((f, i) => {
    // Pohon file: kelompokkan per folder; file di root tampil di bawah "∕".
    const slash = f.path.lastIndexOf("/");
    const dir = slash >= 0 ? f.path.slice(0, slash) : "";
    if (dir !== lastDir) {
      lastDir = dir;
      const h = document.createElement("span");
      h.className = "ov-fdir";
      h.textContent = dir === "" ? "∕" : dir + "/";
      tabs.appendChild(h);
    }
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ov-ftab" + (i === state.overlayFileIdx ? " active" : "");
    b.textContent = slash >= 0 ? f.path.slice(slash + 1) : f.path;
    b.title = f.path;
    b.addEventListener("click", () => {
      state.overlayFileIdx = i;
      void renderCode();
    });
    tabs.appendChild(b);
  });
  const active = viewable[state.overlayFileIdx];
  // Video tidak bisa dibaca sebagai teks: tampilkan info + arahkan ke
  // tombol Unduh (di bawah), jangan fetch binernya ke penampil kode.
  if (/\.(mp4|webm|mov)$/i.test(active.path)) {
    const mb = (active.bytes / 1024 / 1024).toFixed(1);
    $("#ovLineCount").textContent = `${mb} MB`;
    $("#codeGutter").replaceChildren();
    $("#ovPre").textContent =
      "File video — tekan tombol Unduh untuk mengunduhnya.";
    return;
  }
  try {
    const text =
      active.path === version.path && version.content != null
        ? version.content
        : await fetchText(active.path);
    const lines = text.split("\n");
    $("#ovLineCount").textContent = `${lines.length} baris`;
    $("#codeGutter").replaceChildren(
      ...lines.map((_, i) => {
        const s = document.createElement("span");
        s.textContent = String(i + 1);
        return s;
      }),
    );
    $("#ovPre").innerHTML = highlightSyntax(text);
  } catch {
    $("#ovPre").textContent = "Gagal memuat kode.";
  }
}

function openOverlay(version, mode) {
  state.overlayVersion = version;
  state.overlayFiles = [];
  state.overlayFileIdx = 0;
  setFrameSource($("#previewFrame"), version);
  $("#overlay").hidden = false;
  setOverlayMode(mode || "preview");
}

function closeOverlay() {
  $("#overlay").hidden = true;
  const frame = $("#previewFrame");
  frame.removeAttribute("src");
  frame.removeAttribute("srcdoc");
}

document
  .querySelectorAll(".ov-mode")
  .forEach((b) =>
    b.addEventListener("click", () => setOverlayMode(b.dataset.ov)),
  );
document.querySelectorAll("#ovVp button").forEach((b) =>
  b.addEventListener("click", () => {
    document
      .querySelectorAll("#ovVp button")
      .forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    const mobile = b.dataset.vp === "mobile";
    $("#ovStage").classList.toggle("mobile-vp", mobile);
    $("#vpBadge").hidden = !mobile;
  }),
);
$("#ovRefreshBtn").addEventListener("click", () => {
  if (state.overlayVersion)
    setFrameSource($("#previewFrame"), state.overlayVersion);
});
$("#ovNewTabBtn").addEventListener("click", () => {
  const v = state.overlayVersion;
  if (!v) return;
  // Never open agent content as a blob: URL: a blob inherits this page's
  // origin, so its scripts could call the unauthenticated API. /preview/
  // serves the same file with a sandbox CSP, keeping the opaque origin.
  // (Trade-off: an old version opens the file's current content, not the
  // snapshot — the snapshot stays visible in the sandboxed iframe.)
  window.open(previewUrl(v.path), "_blank", "noopener,noreferrer");
});
$("#ovCopyBtn").addEventListener("click", async () => {
  const v = state.overlayVersion;
  if (!v) return;
  try {
    const text = v.content ?? (await fetchText(v.path));
    await navigator.clipboard.writeText(text);
    toast("Kode disalin");
  } catch {
    toast("Gagal menyalin");
  }
});
$("#ovDlBtn").addEventListener("click", () => {
  const v = state.overlayVersion;
  if (!v) return;
  // File video di tab aktif diunduh lewat route /download (attachment,
  // tanpa batas 5 MB seperti zip) — bukan lewat downloadFile yang hanya
  // menangani teks.
  const active = state.overlayFiles[state.overlayFileIdx];
  const path = active?.path ?? v.path;
  if (/\.(mp4|webm|mov)$/i.test(path)) {
    if (!state.sessionId) return;
    const a = document.createElement("a");
    a.href =
      `/api/sessions/${state.sessionId}/download?path=` +
      encodeURIComponent(path);
    a.download = path.split("/").pop() || "video.mp4";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  void downloadFile(v);
});
$("#closeOverlay").addEventListener("click", closeOverlay);

// ---------- Approval ----------

function openApproval(e, runId) {
  // Jangan buka lembar izin saat memutar ulang riwayat: persetujuan lama
  // sudah tidak hidup (tidak ada run yang menunggu), dan menjawabnya
  // diam-diam gagal karena tidak ada run yang menunggu.
  if (state.replaying) return;
  state.approvalId = e.approval_id;
  // runId eksplisit menang: kejadian yang diputar ulang dari riwayat tidak
  // membawa run_id, dan ownRunId() masih null saat reattach belum selesai
  // (probeRunAlive masih menunggu) — tanpa ini lembarnya kebuka tapi
  // jawabannya selalu ditolak "sudah tidak aktif" dan run diam selamanya.
  state.approvalRunId = runId ?? e.run_id ?? ownRunId();
  $("#approveReason").textContent = `${e.reason} (risiko ${e.risk})`;
  $("#approveCmd").textContent = e.command || "";
  $("#approveSheet").hidden = false;
  $("#allowBtn").focus();
}

function closeApproval() {
  state.approvalId = null;
  state.approvalRunId = null;
  state.pendingApproval = null;
  $("#approveSheet").hidden = true;
}

async function answer(decision) {
  if (!state.approvalRunId || !state.approvalId) {
    // Lembar izin basi (mis. dari riwayat atau run sudah selesai):
    // jangan diam saja — tutup dan beri tahu kenapa tombol tidak jalan.
    closeApproval();
    toast("Persetujuan ini sudah tidak aktif. Mulai run baru untuk melanjutkan.");
    return;
  }
  const approvalId = state.approvalId;
  const runId = state.approvalRunId;
  closeApproval();
  try {
    const r = await fetch(`/api/runs/${runId}/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approval_id: approvalId, decision }),
    });
    if (!r.ok) toast("Jawaban tidak terkirim. Mungkin sudah kedaluwarsa.");
  } catch {
    toast("Gagal menghubungi server.");
  }
}
$("#allowBtn").addEventListener("click", () => void answer("allow"));
$("#denyBtn").addEventListener("click", () => void answer("deny"));

// ---------- Events ----------

function handle(e) {
  // Kejadian dari run yang jalan di chat lain: jangan tempelkan ke tampilan
  // chat yang sedang dibuka. Satu-satunya yang diurus: run_finished
  // (bebaskan slot + jalankan antrean) dan approval_requested (beri tahu
  // lewat toast supaya pengguna bisa kembali ke chat itu untuk menjawab).
  const evSessionId = e.run_id ? state.runSessions.get(e.run_id) : undefined;
  if (
    e.run_id &&
    evSessionId !== undefined &&
    evSessionId !== state.sessionId
  ) {
    if (e.type === "run_finished") {
      untrackRun(e.run_id);
      refreshBusyUI();
      drainQueue();
      syncFolderPreviews();
      toast("Agent selesai bekerja di chat lain.");
    } else if (e.type === "approval_requested") {
      toast("Agent minta persetujuan di chat lain — buka chat itu untuk menjawab.");
    }
    return;
  }
  switch (e.type) {
    case "run_started":
      if (!state.think) addThink("Menyusun rencana…");
      break;

    case "text_delta": {
      const box = explainBox();
      state.explainRaw += e.text;
      renderMarkdown(box, state.explainRaw);
      scrollDown();
      break;
    }

    case "tool_call_started":
      state.explainEl = null; // text after a tool call starts a new block
      thinkLine(e.call_id, e.label);
      // Panel langsung menampilkan tool + argumennya — jangan tunggu selesai.
      {
        const startedBody = formatToolCall(e.tool, e.args);
        if (startedBody) {
          showCode(e.tool === "update_plan" ? "Rencana" : e.label, startedBody);
        }
        // Cuplikan kode di bawah label langkah — tampil tapi simpel.
        // run_command tidak perlu: labelnya sudah perintahnya sendiri.
        if (e.tool !== "run_command") {
          const row = state.think && state.think.rows.get(e.call_id);
          if (row) setStepCode(row, startedBody);
        }
      }
      break;

    case "tool_call_finished": {
      const row = state.think && state.think.rows.get(e.call_id);
      if (row) {
        row.line.className = "think-line " + (e.ok ? "ok" : "fail");
        // Label tetap label tool saja (ringkasan ukuran/jumlah tidak
        // ditempel); kode tampil sebagai cuplikan satu baris di bawah
        // label — dari output, kecuali sudah ada cuplikan diff.
        if (e.output_preview && !row.snippetFromDiff) {
          setStepCode(row, e.output_preview);
        }
        // Kode/output asli terbaru tampil di panel think. Label tool:
        // run_command "$ <perintah>", read_file "read_file <path>".
        if (
          e.output_preview &&
          (row.text.startsWith("$ ") || row.text.startsWith("read_file "))
        ) {
          showCode(row.text, e.output_preview);
        }
        // Langkah yang selesai dilipat: cuplikannya disembunyikan supaya
        // daftar tetap pendek dan yang sedang jalan (› + cuplikan)
        // langsung kelihatan — sebelumnya semua baris menampilkan
        // cuplikan, jadi langkah yang selesai tidak kelihatan "tertutup".
        // Yang gagal tetap terbuka (baris error-nya penting).
        if (e.ok && row.snippet) row.snippet.hidden = true;
      }
      break;
    }

    case "approval_requested":
      openApproval(e);
      break;

    case "approval_resolved":
      closeApproval();
      break;

    case "file_changed":
      state.files.set(e.path, { bytes: e.bytes, diff: e.diff });
      if (state.think) {
        state.think.files.add(e.path);
        updateThinkHeader();
      }
      if (e.diff) {
        showCode(`Diff: ${e.path}`, e.diff);
        // Cuplikan diff di bawah langkah write/edit file yang bersangkutan
        // — tapi jangan buka lagi baris yang sudah selesai (langkah
        // selesai tetap terlipat; diff-nya sudah tampil di panel kode).
        const t = state.think;
        if (t) {
          for (const row of [...t.rows.values()].reverse()) {
            if (
              row.text === `write_file ${e.path}` ||
              row.text === `edit_file ${e.path}`
            ) {
              if (
                !row.line.classList.contains("ok") &&
                !row.line.classList.contains("fail")
              ) {
                setStepCode(row, e.diff);
              }
              row.snippetFromDiff = true;
              break;
            }
          }
        }
      }
      break;

    case "verification":
      renderVerification(e);
      break;

    case "usage":
      setMeters(e.totals.steps, e.totals.cost_usd);
      break;

    case "budget_warning":
      toast(
        `Batas ${e.kind === "steps" ? "langkah" : "biaya"} ${e.percent}% tercapai`,
      );
      break;

    case "plan_updated":
      renderPlan(e.items);
      {
        const planBody = formatPlan(e.items);
        if (planBody) showCode("Rencana", planBody);
      }
      break;

    case "checkpoint_created":
      toast(`Checkpoint ${e.method} dibuat (${e.files} file)`);
      break;

    case "checkpoint_restored":
      toast(`Checkpoint dipulihkan (${e.files_restored} file)`);
      if (!$("#tabCheckpoints").hidden) void renderSheetCheckpoints();
      break;

    case "subagent_started":
      thinkLine(`sub:${e.task}`, `Subagent: ${e.task}`);
      toast(
        "Subagent jalan — kuota gratis OpenRouter (50/hari) dipakai bersama",
      );
      break;

    case "subagent_finished": {
      const row = state.think && state.think.rows.get(`sub:${e.task}`);
      if (row) {
        row.line.className =
          "think-line " + (e.status === "completed" ? "ok" : "fail");
        row.label.textContent = `Subagent: ${e.task} — ${e.status} (${e.steps} langkah, $${e.cost_usd.toFixed(4)})`;
      }
      break;
    }

    case "error":
      if (!e.retryable) showRunError(e.message);
      break;

    case "run_finished": {
      closeApproval();
      setMeters(e.totals.steps, e.totals.cost_usd);
      finishThink(e.status, e.totals.steps);
      if (e.status === "error" && !state.errorCard) showRunError(e.summary);
      if (!state.explainEl && e.summary && e.status !== "error") {
        renderMarkdown(explainBox(), e.summary);
      }
      // Bebaskan slot SEBELUM jeda replay: run_finished yang datang saat
      // memutar ulang riwayat (mis. run selesai selagi halaman di-refresh
      // atau EventSource putus lalu tersambung lagi) sebelumnya berhenti di
      // `if (state.replaying) break` dan tidak pernah sampai ke
      // finishRunLive — run tetap tercatat di peta sibuk, input terkunci
      // dan tombol kirim tidak kembali jadi Kirim walau agent sudah
      // selesai (laporan user 2026-11-28). Untrack itu idempotent, jadi
      // pemanggilan ganda (di sini + di finishRunLive) aman.
      untrackRun(e.run_id);
      refreshBusyUI();
      drainQueue();
      if (state.replaying) break;
      renderDiffs();
      void finishRunLive(e);
      if (e.resumable) showResume(e.run_id, e.status);
      break;
    }

    default:
      break;
  }
}

async function finishRunLive(e) {
  // Snapshot this run's result so the version pills keep working even after
  // later runs overwrite the same file in the workspace.
  const htmlFiles = [...state.files.entries()].filter(([p]) =>
    /\.html?$/i.test(p),
  );
  if (htmlFiles.length > 0) {
    const [path, info] = htmlFiles[htmlFiles.length - 1];
    let content = null;
    try {
      const text = await fetchText(path);
      if (text.length <= 512 * 1024) content = text;
    } catch {
      content = null;
    }
    state.versions.push({
      path,
      bytes: info.bytes,
      title: path,
      content,
      runId: e.run_id,
    });
    state.activeVersion = state.versions.length - 1;
    renderResultCard();
    updateRevBar();
  }
  untrackRun(e.run_id);
  refreshBusyUI();
  drainQueue();
  syncFolderPreviews();
}

function listen(runId) {
  const es = new EventSource(`/api/runs/${runId}/events`);
  state.sources.set(runId, es);
  const types = [
    "run_started",
    "text_delta",
    "plan_updated",
    "tool_call_started",
    "tool_call_finished",
    "approval_requested",
    "approval_resolved",
    "file_changed",
    "usage",
    "budget_warning",
    "preview_ready",
    "artifact_ready",
    "checkpoint_created",
    "checkpoint_restored",
    "subagent_started",
    "subagent_finished",
    "verification",
    "error",
    "run_finished",
  ];
  for (const t of types) {
    es.addEventListener(t, (ev) => {
      try {
        handle(JSON.parse(ev.data));
      } catch {
        /* skip a malformed frame */
      }
    });
  }
  // EventSource resumes by itself with Last-Event-ID; it is closed on run_finished.
  // Bila stream putus (mis. server di-restart selagi run jalan), EventSource
  // retry selamanya tanpa run_finished — slot run nyangkut dan antrean
  // tidak jalan. Cek sekali per error: bila run sudah tidak ada di server
  // (404), bebaskan slotnya otomatis.
  let livenessChecked = false;
  es.onerror = () => {
    if (livenessChecked || state.sources.get(runId) !== es) return;
    livenessChecked = true;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    fetch(`/api/runs/${runId}/events`, { signal: ctrl.signal })
      .then((r) => {
        clearTimeout(timer);
        ctrl.abort(); // tutup koneksi probe — status header saja yang dibutuhkan
        if (r.status === 404 && state.sources.get(runId) === es) {
          // Blok think cuma ditutup bila run yang mati itu milik chat yang
          // sedang dibuka; run di chat lain cukup dilepas diam-diam.
          const isOwn = state.runSessions.get(runId) === state.sessionId;
          untrackRun(runId);
          refreshBusyUI();
          if (isOwn) {
            if (state.think) finishThink("stopped", state.think.count);
            toast("Koneksi ke server putus — run dihentikan, sudah bisa pindah chat.");
          }
          drainQueue();
        }
      })
      .catch(() => {
        // Jaringan sempat putus / server belum balas: biarkan EventSource
        // retry sendiri; cek ulang di error berikutnya.
        clearTimeout(timer);
        livenessChecked = false;
      });
  };
}

// Pesan yang dikirim saat slot run penuh (sudah MAX_PARALLEL run jalan
// bareng): simpan + tampilkan sebagai bubble user dengan catatan antrean,
// lalu jalan otomatis begitu ada slot kosong.
function queueMessage(sessionId, message) {
  const files = state.pendingFiles;
  const names = files.map((f) => f.name);
  state.pendingFiles = [];
  renderAttachments();
  const entry = { sessionId, message, files, noteEl: null };
  state.queue.push(entry);
  if (sessionId === state.sessionId) {
    addUser(names.length > 0 ? `${message}\n📎 ${names.join(", ")}` : message);
    const note = document.createElement("div");
    note.className = "queued-note";
    note.textContent =
      "Menunggu giliran — jalan otomatis begitu ada slot run kosong.";
    main.appendChild(note);
    scrollDown(true);
    entry.noteEl = note;
  }
  toast("Pesan masuk antrean — jalan otomatis begitu ada slot kosong.");
}

// Jalankan antrean pertama untuk chat yang sedang dibuka (kalau ada slot kosong).
function drainQueue() {
  if (state.runs.size >= MAX_PARALLEL || state.starting) return;
  const i = state.queue.findIndex((e) => e.sessionId === state.sessionId);
  if (i < 0) return;
  const [entry] = state.queue.splice(i, 1);
  if (entry.noteEl && entry.noteEl.isConnected) entry.noteEl.remove();
  state.pendingFiles = [...state.pendingFiles, ...entry.files];
  renderAttachments();
  void start(entry.message, { alreadyShown: true });
}

/** Cek run masih ada di server atau sudah mati (mis. server restart
 *  selagi run jalan). "unknown" = jaringan sempat putus — jangan vonis
 *  mati, biarkan SSE yang memutuskan lewat liveness check-nya. */
async function probeRunAlive(runId) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch(`/api/runs/${runId}/events`, { signal: ctrl.signal });
    return r.status === 404 ? "dead" : "alive";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

/** Sambung lagi ke run yang masih jalan di server (setelah refresh atau
 *  pindah chat). Server memutar ulang kejadian yang terlewat berdasarkan
 *  seq, jadi tidak ada yang hilang dari tampilan. */
async function reattachRun(sessionId, runId) {
  const alive = await probeRunAlive(runId);
  if (alive === "dead") {
    if (sessionId === state.sessionId && state.think)
      finishThink("stopped", state.think.count);
    return;
  }
  trackRun(sessionId, runId);
  refreshBusyUI();
  listen(runId);
}

/** Saat halaman dimuat: bila ada run yang masih jalan di server (mis.
 *  pengguna refresh selagi agent bekerja), kembali ke chat itu dan
 *  sambung lagi — jangan biarkan pengguna mendarat di layar awal dengan
 *  kesan run-nya berhenti. Pindai daftar sesi berurutan (bukan cuma yang
 *  terbaru): pengguna sering pindah chat, jadi run yang masih jalan bisa
 *  ada di sesi yang lebih lama — dulu cuma list[0] yang dicek, dan refresh
 *  dari chat lain membuat run itu "hilang" dari tampilan. */
async function reattachLiveRun() {
  let list;
  try {
    list = await fetchJson("/api/sessions");
  } catch {
    return;
  }
  if (!Array.isArray(list) || list.length === 0) return;
  // Maks 5 detail: cukup untuk menemukan run yang masih jalan tanpa
  // membanjiri server dengan fetch saat daftar riwayat panjang.
  for (const sess of list.slice(0, 5)) {
    if (!sess || !sess.session_id) continue;
    let detail;
    try {
      detail = await fetchJson(
        `/api/sessions/${encodeURIComponent(sess.session_id)}`,
      );
    } catch {
      continue;
    }
    const unfinished = (detail.runs ?? []).filter(
      (r) => !r.events.some((e) => e.type === "run_finished"),
    );
    if (unfinished.length > 0) {
      await restoreSession(sess.session_id);
      return;
    }
  }
}

async function start(message, opts = {}) {
  // Satu sesi cuma boleh satu run aktif; slot global maks MAX_PARALLEL —
  // run ke-4 masuk antrean, bukan ditolak diam-diam.
  if (!message || ownRunId() || state.starting) return;
  if (state.runs.size >= MAX_PARALLEL) {
    queueMessage(state.sessionId, message);
    return;
  }
  const isNewSession = !state.sessionId;
  state.starting = true;
  refreshBusyUI();
  // Upload first: if it fails, no run starts and the files stay selected.
  let attachmentIds = [];
  let attachedNames = [];
  if (state.pendingFiles.length > 0) {
    attachedNames = state.pendingFiles.map((f) => f.name);
    try {
      attachmentIds = await uploadPendingFiles();
    } catch (err) {
      state.starting = false;
      refreshBusyUI();
      toast(err instanceof Error ? err.message : "Upload gagal.");
      return;
    }
    state.pendingFiles = [];
    renderAttachments();
  }
  state.lastPrompt = message;
  state.errorCard = null;
  state.files.clear();
  state.explainEl = null;
  state.explainRaw = "";
  state.revDismissed = false;
  if (state.planEl) {
    state.planEl.remove();
    state.planEl = null;
  }
  state.planItems = null;
  if (heroEl.isConnected) heroEl.remove();
  // Pesan dari antrean sudah tampil sebagai bubble saat dikirim — jangan ganda.
  if (!opts.alreadyShown) {
    addUser(
      attachedNames.length > 0
        ? `${message}\n📎 ${attachedNames.join(", ")}`
        : message,
    );
  }
  setMeters(0, 0);
  addThink("Menyusun rencana…");
  try {
    const body = { message };
    if (state.sessionId) body.session_id = state.sessionId;
    if (state.curModel) body.model = state.curModel;
    body.effort = state.curEffort;
    if (attachmentIds.length > 0) body.attachment_ids = attachmentIds;
    const r = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.status === 409)
      throw new Error(
        "Masih ada run yang berjalan. Tunggu atau hentikan dulu.",
      );
    if (!r.ok) {
      let detail = "";
      try {
        const b = await r.json();
        if (b && typeof b.error === "string") detail = b.error;
      } catch {
        // fall back to the status below
      }
      throw new Error(detail || `Server menolak permintaan (${r.status}).`);
    }
    const data = await r.json();
    state.sessionId = data.session_id;
    trackRun(data.session_id, data.run_id);
    // Run ini membuat sesi baru (dari layar awal): pesan yang diantre dari
    // layar awal ikut sesi baru ini, bukan nyangkut tanpa sesi.
    if (isNewSession) {
      for (const q of state.queue)
        if (q.sessionId === null) q.sessionId = data.session_id;
    }
    state.starting = false;
    refreshBusyUI();
    listen(data.run_id);
    // Slot mungkin masih sisa — jalankan antrean berikutnya bila ada.
    drainQueue();
  } catch (err) {
    finishThink("error", 0);
    state.starting = false;
    refreshBusyUI();
    addErrorCard(
      "Koneksi ke agent terputus",
      err instanceof Error ? err.message : "Gagal menghubungi server.",
    );
  }
}

async function stopRun() {
  const runId = ownRunId();
  if (!runId) return;
  try {
    const r = await fetch(`/api/runs/${runId}/stop`, { method: "POST" });
    if (r.status === 404) {
      // Run sudah tidak ada di server (mis. server di-restart selagi UI
      // masih menampilkan "berjalan", atau run selesai tapi event
      // run_finished tidak sampai): bebaskan UI supaya riwayat dan tombol
      // lain bisa dipakai lagi, bukan terkunci di "Hentikan agent dulu".
      untrackRun(runId);
      refreshBusyUI();
      if (state.think) finishThink("stopped", state.think.count);
      toast("Agent sudah berhenti — run tidak ditemukan di server.");
      drainQueue();
      return;
    }
    // Minta berhenti berhasil: update UI langsung sebagai "dihentikan" —
    // jangan tunggu run_finished via SSE. Run bisa butuh belasan detik
    // untuk membereskan panggilan LLM yang sedang jalan (live 2026-11-28:
    // run_e03e3314 selesai "stopped" 21 dtk setelah Allow), dan selama itu
    // tampilan tetap "Bekerja" sehingga pengguna mengira tombol Stop tidak
    // jalan. EventSource-nya tetap dibuka supaya run_finished yang datang
    // belakangan tetap bisa menutup bersih + menjalankan antrean; yang
    // dilepas di sini cuma peta sibuk (input langsung hidup lagi).
    closeApproval();
    if (state.think) finishThink("stopped", state.think.count);
    const stopSessionId = state.runSessions.get(runId);
    if (
      stopSessionId !== undefined &&
      state.runs.get(stopSessionId) === runId
    ) {
      state.runs.delete(stopSessionId);
    }
    refreshBusyUI();
    toast("Agent dihentikan.");
  } catch {
    toast("Gagal mengirim perintah henti.");
  }
}

// Lanjutkan run yang berhenti karena batas: server membuat run baru di sesi
// yang sama dengan batas baru; riwayat sesi sudah berisi transkrip run lama,
// jadi agent meneruskan dari titik berhentinya.
function showResume(runId, status) {
  if (!runId) return;
  state.lastRunId = runId;
  const wrap = document.createElement("div");
  wrap.className = "resume-wrap";
  const note = document.createElement("small");
  // Catatan menyesuaikan kenapa run berhenti — intinya sama: lanjutkan
  // dari yang sudah dikerjakan, bukan mulai dari awal (aturan user
  // 2026-11-28). Sebelumnya tombol ini cuma muncul untuk budget_exceeded,
  // jadi run yang dihentikan/error memaksa pengguna kirim pesan baru dan
  // agent sering mengulang pekerjaan dari nol.
  note.textContent =
    status === "budget_exceeded"
      ? "Batas langkah/biaya habis. Lanjutkan dengan batas baru — agent meneruskan dari riwayat sesi ini."
      : status === "stopped"
        ? "Run dihentikan di tengah jalan. Lanjutkan — agent meneruskan dari yang sudah dikerjakan, bukan mulai dari awal."
        : "Run berhenti karena error. Lanjutkan — agent meneruskan dari yang sudah dikerjakan, bukan mulai dari awal.";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn primary";
  btn.textContent = "Lanjutkan run";
  btn.addEventListener("click", () => {
    wrap.remove();
    void resumeRun();
  });
  wrap.append(note, btn);
  const host =
    state.lastThink && state.lastThink.isConnected ? state.lastThink : main;
  host.appendChild(wrap);
}

async function resumeRun() {
  if (!state.lastRunId || ownRunId()) return;
  state.starting = true;
  refreshBusyUI();
  addThink("Melanjutkan run…");
  try {
    const r = await fetch(`/api/runs/${state.lastRunId}/resume`, {
      method: "POST",
    });
    if (r.status === 409)
      throw new Error("Run tidak bisa dilanjutkan sekarang.");
    if (!r.ok) throw new Error(`Server menolak permintaan (${r.status}).`);
    const data = await r.json();
    state.sessionId = data.session_id;
    trackRun(data.session_id, data.run_id);
    state.lastRunId = data.run_id;
    state.starting = false;
    refreshBusyUI();
    listen(data.run_id);
  } catch (err) {
    finishThink("error", 0);
    state.starting = false;
    refreshBusyUI();
    addErrorCard(
      "Gagal melanjutkan run",
      err instanceof Error ? err.message : "Gagal menghubungi server.",
    );
  }
}

function resetSession() {
  // Boleh kembali ke layar awal selagi run jalan — run lanjut di latar
  // (server boleh jalanin sampai 3 run bareng; kirim baru langsung jalan
  // bila ada slot, antre bila penuh).
  closeOverlay();
  closeFolderSheet();
  clearInterval(state.timerInt);
  state.think = null;
  main.replaceChildren(heroEl);
  state.sessionId = null;
  state.lastRunId = null;
  state.approvalId = null;
  state.approvalRunId = null;
  state.files.clear();
  state.versions = [];
  state.activeVersion = -1;
  state.resultCard = null;
  state.revDismissed = false;
  state.explainEl = null;
  state.explainRaw = "";
  setMeters(0, 0);
  input.value = "";
  autoGrow();
  updateSendState();
  updateRevBar();
  paintFolders();
  syncFolderPreviews();
  toast(
    state.busy
      ? "Sesi direset — agent lanjut bekerja di latar"
      : "Sesi direset ke layar awal",
  );
  // Segarkan tombol/input untuk layar baru (run di chat lain tidak
  // mengunci input) + jalankan antrean layar ini bila ada slot.
  refreshBusyUI();
  drainQueue();
}

async function restoreSession(sessionId) {
  // Boleh pindah chat selagi run jalan — run lanjut di latar; saat chat
  // ini dibuka lagi, sambung ke stream run-nya bila masih hidup
  // (reattachRun), supaya kejadian live tetap tertempel dan refresh tidak
  // lagi menampilkan run sebagai "berhenti" padahal server masih kerja.
  let detail;
  try {
    detail = await fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}`);
  } catch {
    toast("Gagal membuka riwayat");
    return;
  }
  closeFolderSheet();
  closeOverlay();
  state.sessionId = detail.session_id;
  state.lastRunId = null;
  state.pendingApproval = null; // izin tertunda milik chat lama — diisi lagi di bawah bila chat ini yang punya
  // Blok think tampilan lama ikut terlepas dari DOM — lepas referensinya
  // supaya replay membangun blok baru untuk chat ini.
  state.think = null;
  state.versions = [];
  state.activeVersion = -1;
  state.resultCard = null;
  state.files.clear();
  state.revDismissed = false;
  main.replaceChildren();
  state.replaying = true;
  try {
    for (const run of detail.runs) {
      state.explainEl = null;
      state.explainRaw = "";
      for (const ev of run.events) {
        try {
          handle(ev);
        } catch (err) {
          // Satu kejadian rusak tidak boleh menggagalkan seluruh restore:
          // lewati dan lanjut ke kejadian berikutnya.
          console.warn("restore: lewati kejadian rusak", err);
        }
      }
    }
  } finally {
    state.replaying = false;
    // Run yang mati tanpa run_finished (mis. server restart) menyisakan
    // blok think + timer yang jalan terus — tutup paksa supaya tidak
    // nyangkut dan run berikutnya dapat blok think baru yang bersih.
    // KECUALI run yang dipulihkan ini masih jalan (pengguna kembali ke
    // chat yang run-nya aktif): blok think-nya harus tetap hidup supaya
    // kejadian live tetap tertempel — reattachRun yang memastikan run-nya
    // masih ada di server.
    const unfinished = detail.runs.filter(
      (r) => !r.events.some((e) => e.type === "run_finished"),
    );
    const liveRun =
      unfinished.find((r) => r.run_id === ownRunId()) ?? unfinished.at(-1);
    if (state.think && !liveRun) finishThink("stopped", state.think.count);
    if (liveRun && liveRun.run_id !== ownRunId()) {
      void reattachRun(detail.session_id, liveRun.run_id);
    }
    // Persetujuan yang masih menggantung (run menunggu jawaban saat halaman
    // di-refresh / chat dibuka lagi): JANGAN buka lembarnya otomatis —
    // aturan user 2026-11-28, lembar itu muncul tiap pindah chat dan
    // mengganggu. Simpan sebagai izin tertunda: label bar proses
    // menunjukkan "Menunggu izin", ketuk label untuk membuka lembarnya.
    // Run tetap menunggu jawaban; tidak ada yang dijawab diam-diam.
    if (liveRun) {
      const evs = liveRun.events;
      const req = [...evs]
        .reverse()
        .find((e) => e.type === "approval_requested");
      const resolved =
        req &&
        evs.some(
          (e) =>
            e.type === "approval_resolved" &&
            e.approval_id === req.approval_id,
        );
      if (req && !resolved) {
        state.pendingApproval = { req, runId: liveRun.run_id };
        if (state.think)
          state.think.labelEl.textContent =
            "Menunggu izin · ketuk untuk menjawab";
        toast("Run ini menunggu izin — ketuk bar proses untuk menjawab.");
      }
    }
  }
  // One version per run; content is the current workspace file (older runs were
  // overwritten, so no snapshot is faked for them).
  state.versions = detail.runs
    .map((run) => {
      const html = [...run.events]
        .reverse()
        .find((ev) => ev.type === "file_changed" && /\.html?$/i.test(ev.path));
      return html
        ? {
            path: html.path,
            bytes: html.bytes,
            title: html.path,
            content: null,
            runId: run.run_id,
          }
        : null;
    })
    .filter(Boolean);
  state.activeVersion = state.versions.length - 1;
  if (state.versions.length) renderResultCard();
  updateRevBar();
  syncFolderPreviews();
  toast(
    state.busy
      ? "Proyek dibuka — agent lanjut bekerja di latar"
      : "Proyek dibuka dari riwayat",
  );
  // Segarkan tombol/input untuk chat yang baru dibuka (run di chat lain
  // tidak mengunci input chat ini) + jalankan antrean chat ini bila ada slot.
  refreshBusyUI();
  drainQueue();
}

// ---------- Input ----------

function autoGrow() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 150) + "px";
}

input.addEventListener("input", () => {
  autoGrow();
  updateSendState();
});

// Desktop: Enter sends, Shift+Enter adds a line. Touch screens: Enter adds a line (use the send button).
input.addEventListener("keydown", (ev) => {
  if (
    ev.key === "Enter" &&
    !ev.shiftKey &&
    !isCoarsePointer &&
    !ev.isComposing
  ) {
    ev.preventDefault();
    $("#form").requestSubmit();
  }
});

$("#form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  // Run di chat ini: tombol berfungsi sebagai Stop. Run di chat lain:
  // kirim seperti biasa — langsung jalan bareng (atau masuk antrean bila
  // slot penuh, start() yang mengurusnya).
  if (ownRunId()) {
    void stopRun();
    return;
  }
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  autoGrow();
  void start(text);
});

$("#resetBtn").addEventListener("click", resetSession);
$("#railNew").addEventListener("click", resetSession);
$("#folderMenuBtn").addEventListener("click", () => openFolderSheet("history"));
$("#closeFolderSheet").addEventListener("click", closeFolderSheet);
folderSheet
  .querySelector(".sheet-backdrop")
  .addEventListener("click", closeFolderSheet);
document.querySelectorAll(".stab").forEach((b) => {
  b.addEventListener("click", () => switchFolderTab(b.dataset.ftab));
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    closePops();
    if (!folderSheet.hidden) closeFolderSheet();
    if (!$("#overlay").hidden) closeOverlay();
  }
});

// ---------- Boot ----------

bindHero();
setMeters(0, 0);
setupVoice();
updateSendState();
updateModelLabel();
syncFolderPreviews();
fetch("/api/config")
  .then((r) => r.json())
  .then((cfg) => {
    state.cfg = cfg;
    state.models =
      Array.isArray(cfg.models) && cfg.models.length
        ? cfg.models
        : cfg.model
          ? [cfg.model]
          : [];
    const prefs = loadPrefs();
    state.curModel = state.models.includes(prefs.model)
      ? prefs.model
      : (state.models[0] ?? null);
    state.curEffort = prefs.effort || state.curEffort;
    $("#stModel").textContent = state.curModel ?? "belum dikonfigurasi";
    updateModelLabel();
    if (!state.curModel)
      $("#modelLabel").textContent = "LLM belum dikonfigurasi";
    renderModelList();
    setMeters(0, 0);
  })
  .catch(() => {
    $("#modelLabel").textContent = "server tidak terjangkau";
  });

// Sambung lagi ke run yang masih jalan (kalau ada) — pengguna yang
// refresh selagi agent bekerja langsung kembali ke chat itu.
void reattachLiveRun();
