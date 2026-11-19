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

const state = {
  cfg: null,
  models: [],
  curModel: null,
  curEffort: "sedang",
  runId: null,
  sessionId: null,
  source: null,
  busy: false,
  replaying: false,
  lastPrompt: "",
  approvalId: null,
  think: null, // { block, labelEl, timer, linesEl, rows: Map, count }
  planEl: null, // Todo panel (Fase 5), rendered from plan_updated events
  lastThink: null, // finished think block, for the resume button
  explainEl: null,
  explainRaw: "",
  files: new Map(), // path -> { bytes }
  versions: [], // { path, bytes, title, content: string|null, runId }
  activeVersion: -1,
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

function setBusy(on) {
  state.busy = on;
  sendBtn.classList.toggle("stop", on);
  const icon = $("#tplIcons").content.querySelector(
    `[data-ic="${on ? "stop" : "send"}"]`,
  );
  sendBtn.replaceChildren(icon.firstElementChild.cloneNode(true));
  sendBtn.setAttribute("aria-label", on ? "Hentikan agent" : "Kirim");
  input.disabled = on;
  updateSendState();
  if (!on) input.focus();
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
      $("#fhCount").textContent = `${sessions.length} proyek tersimpan`;
      $("#fhSheet1").textContent = sessions[0]
        ? shortText(sessions[0].title, 15)
        : "—";
      $("#fhSheet2").textContent = sessions[1]
        ? shortText(sessions[1].title, 15)
        : "—";
      renderRail(sessions);
    })
    .catch(() => {
      $("#fhCount").textContent = "riwayat tak termuat";
    });
  fetchJson("/api/skills")
    .then((skills) => {
      $("#fsCount").textContent = `${skills.length} skill aktif`;
      $("#fsSheet1").textContent = skills.length
        ? shortText(skills[skills.length - 1].name, 16)
        : "—";
      $("#fsSheet2").textContent = skills[0]
        ? shortText(skills[0].name, 16)
        : "—";
    })
    .catch(() => {
      $("#fsCount").textContent = "skill tak termuat";
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
  if (tabName === "history") void renderSheetHistory();
  if (tabName === "skills") void renderSheetSkills();
  if (tabName === "checkpoints") void renderSheetCheckpoints();
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
        item.append(mainEl, dl);
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
      if (!state.busy) void start(s.dataset.prompt || "");
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
  const box = $("#modelList");
  box.replaceChildren();
  for (const [i, m] of state.models.entries()) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pop-i" + (m === state.curModel ? " sel" : "");
    const wrap = document.createElement("span");
    wrap.className = "pop-b";
    const name = document.createElement("b");
    name.textContent = m;
    const sub = document.createElement("small");
    sub.textContent =
      i === 0 ? "Model utama server" : "Model alternatif dari server";
    wrap.append(name, sub);
    const check = document.createElement("span");
    check.className = "pop-check";
    b.append(wrap, check);
    b.addEventListener("click", () => {
      state.curModel = m;
      savePrefs();
      updateModelLabel();
      renderModelList();
      closePops();
    });
    box.appendChild(b);
  }
  if (!state.models.length) {
    const empty = document.createElement("div");
    empty.className = "exp-empty";
    empty.textContent = "Tidak ada model dari server.";
    box.appendChild(empty);
  }
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
  if (!raw) {
    input.value =
      "Buatkan landing page modern lengkap dengan hero section, fitur unggulan, dan tombol CTA responsif";
  } else if (raw.length < 70) {
    input.value =
      raw +
      " — buat tampilannya modern, responsif di HP dan desktop, lengkap dengan section fitur dan tombol aksi yang jelas.";
  } else {
    toast("Prompt sudah cukup detail");
    return;
  }
  input.dispatchEvent(new Event("input"));
  input.focus();
  toast("Prompt diperjelas otomatis");
});

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
  main.appendChild(block);
  scrollDown(true);
  state.startedAt = Date.now();
  clearInterval(state.timerInt);
  state.timerInt = setInterval(() => {
    timer.textContent =
      ((Date.now() - state.startedAt) / 1000).toFixed(1) + "s";
  }, 100);
  state.think = {
    block,
    labelEl,
    timer,
    linesEl: block.querySelector(".think-lines"),
    rows: new Map(),
    count: 0,
  };
}

function thinkLine(callId, text) {
  const t = state.think;
  if (!t) return;
  const line = document.createElement("div");
  line.className = "think-line";
  line.textContent = text;
  t.linesEl.appendChild(line);
  t.rows.set(callId, { line, text });
  t.count += 1;
  t.labelEl.textContent = text;
  scrollDown();
}

function finishThink(status, steps) {
  clearInterval(state.timerInt);
  const t = state.think;
  if (!t) return;
  t.timer.textContent =
    ((Date.now() - state.startedAt) / 1000).toFixed(1) + "s";
  t.labelEl.classList.remove("shimmer");
  if (t.count === 0) {
    t.block.remove(); // a plain chat answer needs no "steps" block
  } else {
    const labels = {
      completed: `Selesai · ${steps} langkah`,
      stopped: "Dihentikan pengguna",
      budget_exceeded: "Berhenti: batas tercapai",
      error: "Berhenti karena error",
    };
    t.labelEl.textContent = labels[status] || "Selesai";
    t.block.classList.add(status === "error" ? "err" : "done");
    if (status === "completed") t.block.classList.add("collapsed");
  }
  state.lastThink = t.count === 0 ? null : t.block;
  state.think = null;
}

// ---------- Fase 5: Todo panel (plan_updated) ----------

function renderPlan(items) {
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
    if (!state.busy && state.lastPrompt) void start(state.lastPrompt);
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
    Math.max(150, Math.min(210, Math.round(560 * scale))) + "px";
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
    if (!state.busy && state.lastPrompt) void start(state.lastPrompt);
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
    .filter((f) => /\.(html?|css|js|mjs|json|md|txt|svg)$/i.test(f.path))
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
  if (state.overlayVersion) void downloadFile(state.overlayVersion);
});
$("#closeOverlay").addEventListener("click", closeOverlay);

// ---------- Approval ----------

function openApproval(e) {
  // Jangan buka lembar izin saat memutar ulang riwayat: persetujuan lama
  // sudah tidak hidup (tidak ada run yang menunggu), dan menjawabnya
  // diam-diam gagal karena state.runId kosong.
  if (state.replaying) return;
  state.approvalId = e.approval_id;
  $("#approveReason").textContent = `${e.reason} (risiko ${e.risk})`;
  $("#approveCmd").textContent = e.command || "";
  $("#approveSheet").hidden = false;
  $("#allowBtn").focus();
}

function closeApproval() {
  state.approvalId = null;
  $("#approveSheet").hidden = true;
}

async function answer(decision) {
  if (!state.runId || !state.approvalId) {
    // Lembar izin basi (mis. dari riwayat atau run sudah selesai):
    // jangan diam saja — tutup dan beri tahu kenapa tombol tidak jalan.
    closeApproval();
    toast("Persetujuan ini sudah tidak aktif. Mulai run baru untuk melanjutkan.");
    return;
  }
  const approvalId = state.approvalId;
  closeApproval();
  try {
    const r = await fetch(`/api/runs/${state.runId}/approval`, {
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
      break;

    case "tool_call_finished": {
      const row = state.think && state.think.rows.get(e.call_id);
      if (row) {
        row.line.className = "think-line " + (e.ok ? "ok" : "fail");
        row.line.textContent = e.summary
          ? `${row.text} — ${e.summary}`
          : row.text;
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
        row.line.textContent = `Subagent: ${e.task} — ${e.status} (${e.steps} langkah, $${e.cost_usd.toFixed(4)})`;
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
      if (state.replaying) break;
      renderDiffs();
      void finishRunLive(e);
      if (e.status === "budget_exceeded" && e.resumable) showResume();
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
      runId: state.runId,
    });
    state.activeVersion = state.versions.length - 1;
    renderResultCard();
    updateRevBar();
  }
  if (state.source) state.source.close();
  state.source = null;
  setBusy(false);
  syncFolderPreviews();
}

function listen(runId) {
  const es = new EventSource(`/api/runs/${runId}/events`);
  state.source = es;
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
}

async function start(message) {
  if (!message || state.busy) return;
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
  if (heroEl.isConnected) heroEl.remove();
  addUser(message);
  setBusy(true);
  setMeters(0, 0);
  addThink("Menyusun rencana…");
  try {
    const body = { message };
    if (state.sessionId) body.session_id = state.sessionId;
    if (state.curModel) body.model = state.curModel;
    body.effort = state.curEffort;
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
    state.runId = data.run_id;
    state.sessionId = data.session_id;
    listen(data.run_id);
  } catch (err) {
    finishThink("error", 0);
    setBusy(false);
    addErrorCard(
      "Koneksi ke agent terputus",
      err instanceof Error ? err.message : "Gagal menghubungi server.",
    );
  }
}

async function stopRun() {
  if (!state.busy || !state.runId) return;
  try {
    await fetch(`/api/runs/${state.runId}/stop`, { method: "POST" });
    toast("Menghentikan agent…");
  } catch {
    toast("Gagal mengirim perintah henti.");
  }
}

// Lanjutkan run yang berhenti karena batas: server membuat run baru di sesi
// yang sama dengan batas baru; riwayat sesi sudah berisi transkrip run lama,
// jadi agent meneruskan dari titik berhentinya.
function showResume() {
  if (!state.runId) return;
  const wrap = document.createElement("div");
  wrap.className = "resume-wrap";
  const note = document.createElement("small");
  note.textContent =
    "Batas langkah/biaya habis. Lanjutkan dengan batas baru — agent meneruskan dari riwayat sesi ini.";
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
  if (!state.runId || state.busy) return;
  setBusy(true);
  addThink("Melanjutkan run…");
  try {
    const r = await fetch(`/api/runs/${state.runId}/resume`, {
      method: "POST",
    });
    if (r.status === 409)
      throw new Error("Run tidak bisa dilanjutkan sekarang.");
    if (!r.ok) throw new Error(`Server menolak permintaan (${r.status}).`);
    const data = await r.json();
    state.runId = data.run_id;
    state.sessionId = data.session_id;
    listen(data.run_id);
  } catch (err) {
    finishThink("error", 0);
    setBusy(false);
    addErrorCard(
      "Gagal melanjutkan run",
      err instanceof Error ? err.message : "Gagal menghubungi server.",
    );
  }
}

function resetSession() {
  if (state.busy) {
    toast("Hentikan agent dulu");
    return;
  }
  closeOverlay();
  closeFolderSheet();
  main.replaceChildren(heroEl);
  state.runId = null;
  state.sessionId = null;
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
  toast("Sesi direset ke layar awal");
}

async function restoreSession(sessionId) {
  if (state.busy) {
    toast("Hentikan agent dulu");
    return;
  }
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
  state.versions = [];
  state.activeVersion = -1;
  state.resultCard = null;
  state.files.clear();
  state.revDismissed = false;
  main.replaceChildren();
  state.replaying = true;
  for (const run of detail.runs) {
    state.explainEl = null;
    state.explainRaw = "";
    for (const ev of run.events) handle(ev);
  }
  state.replaying = false;
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
  toast("Proyek dibuka dari riwayat");
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
  if (state.busy) {
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

// ---------- Kuota harian :free (Fase 8) ----------
// Reads the same ledger endpoint as ledger.js and shows today's shared
// :free pool usage from the latest run's quota snapshot. Hidden when the
// latest run recorded no :free usage (or no run exists yet). A failed poll
// never breaks the UI — the last shown text simply stays.
async function refreshQuotaLine() {
  const el = $("#quotaLine");
  if (!el) return;
  try {
    const sRes = await fetch("/api/sessions");
    if (!sRes.ok) return;
    const sessions = await sRes.json();
    if (!Array.isArray(sessions) || sessions.length === 0) {
      el.hidden = true;
      return;
    }
    const lRes = await fetch(
      "/api/sessions/" + sessions[0].session_id + "/ledger",
    );
    if (!lRes.ok) return;
    const ledgers = await lRes.json();
    const latest =
      Array.isArray(ledgers) && ledgers.length > 0
        ? ledgers[ledgers.length - 1]
        : null;
    const q = latest && latest.quota;
    if (!q) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.textContent =
      "Kuota :free hari ini (UTC " +
      q.date +
      "): " +
      q.free_used +
      "/" +
      q.free_limit +
      " request · run ini: " +
      latest.llm_calls +
      " pgl LLM" +
      (q.free_used >= q.free_limit
        ? " — kuota habis, run berikutnya pindah provider atau berhenti"
        : "");
  } catch (e) {
    /* keep the last shown text */
  }
}
refreshQuotaLine();
setInterval(refreshQuotaLine, 15000);
document.addEventListener("submit", () => setTimeout(refreshQuotaLine, 1500));

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
