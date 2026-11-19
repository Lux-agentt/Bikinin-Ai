// Run cost/time ledger panel (Fase 7, Track B). Standalone: it never touches
// app.js state. It polls GET /api/sessions (newest first) and then
// GET /api/sessions/:id/ledger, and renders the latest run. Fast poll
// (2s) only while a run is live, slow poll (15s) otherwise, so it adds no
// LLM calls and negligible traffic.
(function () {
  "use strict";

  var FAST_MS = 2000;
  var SLOW_MS = 15000;
  var panel = null;
  var usdIdr = 17000;
  var timer = null;
  var lastKey = "";

  function fmtUsd(n) {
    return "$" + (typeof n === "number" ? n.toFixed(4) : "0.0000");
  }
  function fmtIdr(n) {
    if (typeof n !== "number" || !isFinite(n)) return "≈ Rp 0";
    return "≈ Rp " + Math.round(n * usdIdr).toLocaleString("id-ID");
  }
  function fmtDur(ms) {
    if (ms == null || !isFinite(ms)) return "—";
    if (ms < 1000) return ms + " ms";
    var s = ms / 1000;
    if (s < 60) return s.toFixed(1) + " dtk";
    return Math.floor(s / 60) + " mnt " + Math.round(s % 60) + " dtk";
  }
  function fmtNum(n) {
    return typeof n === "number" ? n.toLocaleString("id-ID") : "0";
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var STATUS_LABEL = {
    running: "Berjalan",
    completed: "Selesai",
    stopped: "Dihentikan",
    error: "Error",
    budget_exceeded: "Batas tercapai",
  };

  function buildPanel() {
    var el = document.createElement("section");
    el.className = "ledger-panel";
    el.id = "ledgerPanel";
    el.setAttribute("aria-label", "Biaya dan waktu run");
    el.innerHTML =
      '<div class="ledger-head" role="button" tabindex="0" aria-expanded="true" title="Ketuk untuk melipat / membuka rincian biaya">' +
      "<b>Biaya run</b>" +
      '<span class="ledger-summary" data-role="summary" hidden></span>' +
      '<span class="ledger-status" data-role="status">—</span>' +
      '<svg class="ledger-chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></div>' +
      '<div class="ledger-grid">' +
      '<div><span>Model</span><b data-role="model">—</b></div>' +
      '<div><span>Token in / out</span><b data-role="tokens">—</b></div>' +
      '<div><span>Biaya</span><b data-role="cost">—</b></div>' +
      '<div><span>Durasi</span><b data-role="duration">—</b></div>' +
      '<div><span>Langkah</span><b data-role="steps">—</b></div>' +
      '<div><span>Tool call</span><b data-role="tools">—</b></div>' +
      "</div>" +
      '<div class="ledger-tools" data-role="bytool" hidden></div>' +
      '<div class="ledger-foot" data-role="foot">Belum ada run.</div>';
    var head = el.querySelector(".ledger-head");
    var toggle = function () {
      setCollapsed(!el.classList.contains("collapsed"), true);
    };
    if (head) {
      head.addEventListener("click", toggle);
      head.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      });
    }
    // Panel tinggal di dalam chat (ujung stage) supaya ikut ke-scroll dan
    // tidak nempel permanen di bawah chat. Kalau #main tidak ada, jatuh ke body.
    var stage = document.querySelector("#main");
    if (stage) stage.appendChild(el);
    else document.body.appendChild(el);
    return el;
  }

  // manual: null = ikut aturan otomatis (run selesai -> lipat, run jalan ->
  // buka), true/false = pilihan terakhir user, selalu dihormati render().
  var manual = null;

  function setCollapsed(collapsed, byUser) {
    if (!panel) return;
    if (byUser) manual = !collapsed;
    panel.classList.toggle("collapsed", collapsed);
    var head = panel.querySelector(".ledger-head");
    if (head) head.setAttribute("aria-expanded", collapsed ? "false" : "true");
    var summary = panel.querySelector('[data-role="summary"]');
    if (summary) summary.hidden = !collapsed;
  }

  function render(latest) {
    var q = function (role) {
      return panel.querySelector('[data-role="' + role + '"]');
    };
    if (!latest) {
      // Belum ada run: jangan tampilkan panel kosong di chat.
      if (!panel) return;
      q("status").textContent = "—";
      q("foot").textContent = "Belum ada run.";
      setCollapsed(false, false);
      return;
    }
    if (!panel) panel = buildPanel();
    q("status").textContent = STATUS_LABEL[latest.status] || latest.status;
    q("status").dataset.status = latest.status;
    q("model").textContent =
      latest.models && latest.models.length > 1
        ? latest.models.join(" → ")
        : latest.model || "—";
    q("tokens").textContent =
      fmtNum(latest.input_tokens) +
      " / " +
      fmtNum(latest.output_tokens) +
      (latest.cached_tokens ? " (" + fmtNum(latest.cached_tokens) + " cache)" : "");
    q("cost").textContent = fmtUsd(latest.cost_usd) + " · " + fmtIdr(latest.cost_usd);
    q("duration").textContent = fmtDur(latest.duration_ms);
    q("steps").textContent = fmtNum(latest.steps) + " · " + fmtNum(latest.llm_calls) + " pgl LLM";
    var tc = latest.tool_calls || { total: 0, ok: 0, failed: 0, by_tool: {} };
    q("tools").textContent =
      fmtNum(tc.total) + " (" + fmtNum(tc.ok) + " ok" + (tc.failed ? ", " + fmtNum(tc.failed) + " gagal" : "") + ")";
    var by = q("bytool");
    var names = Object.keys(tc.by_tool || {});
    if (names.length > 0) {
      by.hidden = false;
      by.innerHTML = names
        .map(function (name) {
          var s = tc.by_tool[name];
          return (
            "<span>" + esc(name) + " ×" + fmtNum(s.total) +
            (s.failed ? ' <i class="ledger-fail">' + fmtNum(s.failed) + " gagal</i>" : "") +
            "</span>"
          );
        })
        .join("");
    } else {
      by.hidden = true;
      by.innerHTML = "";
    }
    q("foot").textContent =
      "Run " + latest.run_id +
      (latest.started_at ? " · mulai " + new Date(latest.started_at).toLocaleTimeString("id-ID") : "") +
      " · biaya dihitung dari harga token provider (bukan dari field biaya provider).";
    // Panel lipat: run selesai -> ringkas (hemat layar HP), run jalan -> buka.
    var summary = q("summary");
    if (summary) {
      summary.textContent =
        fmtUsd(latest.cost_usd) + " · " + fmtDur(latest.duration_ms);
    }
    if (manual === null) setCollapsed(latest.status !== "running", false);
    else setCollapsed(!manual, false);
    // Jaga panel tetap di ujung bawah chat (pesan baru masuk di bawahnya saat
    // run jalan; kalau stage sempat dibersihkan app.js, panel nempel lagi).
    var stage = document.querySelector("#main");
    if (stage) stage.appendChild(panel);
  }

  function runActive() {
    // app.js shows a think block while a run is live.
    return !!document.querySelector(".think-block");
  }

  async function refresh() {
    try {
      var sRes = await fetch("/api/sessions");
      if (!sRes.ok) return;
      var sessions = await sRes.json();
      if (!Array.isArray(sessions) || sessions.length === 0) {
        render(null);
        return;
      }
      var sessionId = sessions[0].session_id;
      var lRes = await fetch("/api/sessions/" + sessionId + "/ledger");
      if (!lRes.ok) return;
      var ledgers = await lRes.json();
      if (!Array.isArray(ledgers) || ledgers.length === 0) {
        render(null);
        return;
      }
      var latest = ledgers[ledgers.length - 1];
      var key = latest.run_id + "|" + latest.status + "|" + latest.llm_calls + "|" + latest.tool_calls.total;
      if (key !== lastKey) {
        lastKey = key;
        render(latest);
      } else if (latest.status === "running") {
        render(latest); // live numbers (duration/cost) keep moving
      }
      schedule(latest.status === "running" || runActive() ? FAST_MS : SLOW_MS);
    } catch (e) {
      schedule(SLOW_MS);
    }
  }

  function schedule(ms) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(refresh, ms);
  }

  async function init() {
    try {
      var cRes = await fetch("/api/config");
      if (cRes.ok) {
        var cfg = await cRes.json();
        if (typeof cfg.usd_idr === "number" && cfg.usd_idr > 0) usdIdr = cfg.usd_idr;
      }
    } catch (e) {
      /* keep the default rate */
    }
    // Panel dibuat render() saat ada run pertama (jangan tampil kosong).
    // Refresh sooner when the user sends a prompt (a new run starts).
    document.addEventListener("submit", function () {
      lastKey = "";
      setTimeout(refresh, 800);
    });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) refresh();
    });
    refresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Debug / reuse hook; app.js does not depend on it.
  window.BikininLedger = { refresh: refresh };
})();
