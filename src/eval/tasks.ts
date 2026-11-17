// Eval task definitions (Fase 7). 16 standard tasks across 6 categories:
// bugfix, feature, research, fileops, edge cases, and human-like behaviour.
// Target: near-human parity (memahami maksud samar, bertanya saat ragu,
// menjelaskan alasan, mengakui kesalahan, mengingat konteks) — measured
// against a human baseline (docs/eval-baseline.md), never framed as
// "beating humans".
//
// Each task has an AUTOMATIC pass/fail check: file assertions, running the
// produced code, or a deterministic proxy over the event log / transcript.
// Behaviour dimensions use proxies (did the agent ask before mutating?
// does the final summary state a reason? does it admit a mistake?) and
// carry a manual note: the proxy checks THAT it happened, a human still
// judges HOW WELL it happened from the event log.
//
// `dummyScript` is scripted REFERENCE behaviour for the dummy model: it
// drives runAgent through the exact tool calls a competent agent would
// make, so `npm run eval` in dummy mode verifies the HARNESS end to end
// (scoring, logging, reporting) with zero cost and no API key. Dummy-mode
// scores measure the harness, NOT model capability. One script is
// deliberately wrong (behavior-ambiguous) so the fail path is exercised
// too; network tasks are skipped honestly in dummy mode, never faked.
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ChatResult, ToolCallReq } from "../llm/client.js";
import {
  askedBeforeMutating,
  fail,
  pass,
  readText,
  runNode,
  summaryStatesReason,
  type CheckContext,
  type CheckOutcome,
} from "./checks.js";

export type EvalCategory =
  | "bugfix"
  | "feature"
  | "research"
  | "fileops"
  | "edge"
  | "behavior";

export interface EvalTask {
  id: string;
  category: EvalCategory;
  title: string;
  prompt: string;
  /** Needs the network (e.g. web_search): skipped honestly in dummy mode. */
  requiresNetwork?: boolean;
  /** Files seeded into the task workspace before the run. */
  setup?: Record<string, string>;
  /** Prior conversation replayed before the task prompt. */
  history?: ChatCompletionMessageParam[];
  check: (ctx: CheckContext) => CheckOutcome | Promise<CheckOutcome>;
  /** Scripted reference behaviour for the dummy model (see header). */
  dummyScript?: ChatResult[];
}

const usage = { input_tokens: 100, output_tokens: 20, cached_tokens: 0 };

function call(id: string, name: string, args: unknown): ToolCallReq {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}
const withCalls = (...toolCalls: ToolCallReq[]): ChatResult => ({
  text: "",
  toolCalls,
  usage,
});
const finalText = (text: string): ChatResult => ({ text, toolCalls: [], usage });

const ASK_MANUAL =
  "Proxy otomatis hanya memeriksa APAKAH agent bertanya sebelum mengubah file; ketepatan isi pertanyaan dinilai manual dari log event.";

export const TASKS: EvalTask[] = [
  // ---------- bugfix ----------
  {
    id: "bugfix-off-by-one",
    category: "bugfix",
    title: "Perbaiki off-by-one di sum.js",
    prompt:
      "Perbaiki bug di sum.js: hasilnya NaN, seharusnya 15. Jangan ubah angka di array.",
    setup: {
      "sum.js": `function sum(arr) {
  let total = 0;
  for (let i = 0; i <= arr.length; i++) total += arr[i];
  return total;
}
console.log(sum([1, 2, 3, 4, 5]));
`,
    },
    check: async (ctx) => {
      const r = await runNode(ctx, "sum.js");
      if (!r.ok) return fail(`node sum.js gagal: ${r.out}`);
      return r.out === "15"
        ? pass("node sum.js mencetak 15")
        : fail(`node sum.js mencetak "${r.out}", seharusnya 15`);
    },
    dummyScript: [
      withCalls(call("t1", "read_file", { path: "sum.js" })),
      withCalls(
        call("t2", "edit_file", {
          path: "sum.js",
          old_str: "i <= arr.length",
          new_str: "i < arr.length",
        }),
      ),
      withCalls(call("t3", "run_command", { command: "node sum.js" })),
      finalText("Selesai. Perulangan diperbaiki karena indeks terakhir array melebihi batas."),
    ],
  },
  {
    id: "bugfix-config-type",
    category: "bugfix",
    title: "Perbaiki tipe port di config.json",
    prompt: "Perbaiki config.json: port harus angka, bukan string.",
    setup: {
      "config.json": `{"port": "3000", "host": "localhost"}\n`,
    },
    check: async (ctx) => {
      const text = await readText(ctx, "config.json");
      if (text === null) return fail("config.json tidak ada");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return fail("config.json bukan JSON valid");
      }
      const port = (parsed as { port?: unknown }).port;
      return port === 3000
        ? pass("port adalah angka 3000")
        : fail(`port bernilai ${JSON.stringify(port)}, seharusnya angka 3000`);
    },
    dummyScript: [
      withCalls(call("t1", "read_file", { path: "config.json" })),
      withCalls(
        call("t2", "edit_file", {
          path: "config.json",
          old_str: '"port": "3000"',
          new_str: '"port": 3000',
        }),
      ),
      finalText("Selesai, port sekarang angka karena server membaca port sebagai bilangan."),
    ],
  },

  // ---------- feature ----------
  {
    id: "feature-landing",
    category: "feature",
    title: "Landing page kedai kopi",
    prompt:
      "Buatkan index.html landing page kedai kopi 'Kopi Pagi' dengan judul, deskripsi singkat, dan daftar 3 menu.",
    check: async (ctx) => {
      const text = await readText(ctx, "index.html");
      if (text === null) return fail("index.html tidak dibuat");
      for (const needle of ["Kopi Pagi", "<h1", "</html>"]) {
        if (!text.includes(needle))
          return fail(`index.html tidak memuat "${needle}"`);
      }
      return pass("index.html memuat judul, h1, dan penutup html");
    },
    dummyScript: [
      withCalls(
        call("t1", "write_file", {
          path: "index.html",
          content: `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><title>Kopi Pagi</title></head>
<body><h1>Kopi Pagi</h1><p>Kedai kopi rumahan, diseduh pelan setiap pagi.</p>
<ul><li>Kopi Tubruk</li><li>Kopi Susu Gula Aren</li><li>Es Kopi Pagi</li></ul>
</body></html>
`,
        }),
      ),
      finalText("Selesai. Landing page dibuat dengan HTML polos karena tugasnya satu halaman dan supaya cepat dibuka."),
    ],
  },
  {
    id: "feature-todo-cli",
    category: "feature",
    title: "CLI todo kecil",
    prompt:
      'Buatkan todo.js: CLI kecil, `node todo.js` tanpa argumen menampilkan cara pakai, `node todo.js tambah "beli susu"` menyimpan tugas ke todos.json.',
    check: async (ctx) => {
      const usageOut = await runNode(ctx, "todo.js");
      if (!usageOut.ok || !/cara pakai/i.test(usageOut.out))
        return fail(`node todo.js tanpa argumen tidak menampilkan cara pakai: "${usageOut.out}"`);
      const add = await runNode(ctx, "todo.js", ["tambah", "beli susu"]);
      if (!add.ok) return fail(`node todo.js tambah gagal: ${add.out}`);
      const saved = await readText(ctx, "todos.json");
      if (saved === null || !saved.includes("beli susu"))
        return fail("todos.json tidak memuat 'beli susu'");
      return pass("cara pakai tampil dan tugas tersimpan di todos.json");
    },
    dummyScript: [
      withCalls(
        call("t1", "write_file", {
          path: "todo.js",
          content: `const fs = require("fs");
const [cmd, item] = process.argv.slice(2);
if (cmd === "tambah" && item) {
  const list = fs.existsSync("todos.json")
    ? JSON.parse(fs.readFileSync("todos.json", "utf8"))
    : [];
  list.push(item);
  fs.writeFileSync("todos.json", JSON.stringify(list, null, 2));
  console.log("Ditambah: " + item);
} else {
  console.log('Cara pakai: node todo.js tambah "<tugas>"');
}
`,
        }),
      ),
      withCalls(call("t2", "run_command", { command: "node todo.js" })),
      finalText("Selesai. CLI memakai file JSON karena tugasnya kecil dan supaya mudah dibaca."),
    ],
  },

  // ---------- research ----------
  {
    id: "research-local",
    category: "research",
    title: "Jawab dari README",
    prompt:
      "Dari README.md, jawab: jam berapa warung buka dan berapa port servernya?",
    setup: {
      "README.md":
        "# Warung Kopi Pagi\nBuka jam 07.00-21.00. Port server 3000. Menu andalan: kopi tubruk.\n",
    },
    check: (ctx) =>
      ctx.summary.includes("07.00") && ctx.summary.includes("3000")
        ? pass("jawaban memuat jam buka 07.00 dan port 3000")
        : fail(`jawaban tidak memuat jam/port: "${ctx.summary.slice(0, 120)}"`),
    dummyScript: [
      withCalls(call("t1", "read_file", { path: "README.md" })),
      finalText("Buka jam 07.00-21.00, port server 3000."),
    ],
  },
  {
    id: "research-web",
    category: "research",
    title: "Cari harga domain .id terbaru",
    prompt:
      "Cari harga domain .id terbaru dari hasil pencarian dan ringkas dalam 3 poin.",
    requiresNetwork: true,
    check: (ctx) => {
      const searched = ctx.events.some(
        (e) => e.type === "tool_call_started" && e.tool === "web_search",
      );
      if (!searched) return fail("tool web_search tidak pernah dipanggil");
      return ctx.summary.length > 20
        ? pass("web_search dipakai dan ringkasan diberikan")
        : fail("ringkasan terlalu pendek");
    },
    // No dummyScript: skipped honestly in dummy mode.
  },

  // ---------- file ops ----------
  {
    id: "fileops-copy",
    category: "fileops",
    title: "Salin file ke arsip",
    prompt: "Salin a.txt ke arsip/a.txt dengan isi yang sama persis.",
    setup: { "a.txt": "Isi penting: rapat jam 10.\n" },
    check: async (ctx) => {
      const src = await readText(ctx, "a.txt");
      const dst = await readText(ctx, "arsip/a.txt");
      if (dst === null) return fail("arsip/a.txt tidak dibuat");
      return dst === src
        ? pass("arsip/a.txt isinya sama persis dengan a.txt")
        : fail("isi arsip/a.txt berbeda dari a.txt");
    },
    dummyScript: [
      withCalls(call("t1", "read_file", { path: "a.txt" })),
      withCalls(
        call("t2", "write_file", {
          path: "arsip/a.txt",
          content: "Isi penting: rapat jam 10.\n",
        }),
      ),
      finalText("Selesai, a.txt disalin ke arsip/a.txt."),
    ],
  },
  {
    id: "fileops-summarize",
    category: "fileops",
    title: "Ringkasan dari catatan",
    prompt:
      "Buatkan ringkasan.md yang memuat tiga poin dari catatan.txt: rapat, stok gula, dan promo.",
    setup: {
      "catatan.txt":
        "Rapat Senin jam 10 membahas harga kopi.\nStok gula habis, pesan 5 kg.\nPromo akhir bulan: beli 2 gratis 1.\n",
    },
    check: async (ctx) => {
      const text = await readText(ctx, "ringkasan.md");
      if (text === null) return fail("ringkasan.md tidak dibuat");
      const lower = text.toLowerCase();
      return lower.includes("rapat") &&
        lower.includes("gula") &&
        lower.includes("promo")
        ? pass("ringkasan.md memuat rapat, gula, dan promo")
        : fail("ringkasan.md tidak memuat ketiga poin (rapat, gula, promo)");
    },
    dummyScript: [
      withCalls(call("t1", "read_file", { path: "catatan.txt" })),
      withCalls(
        call("t2", "write_file", {
          path: "ringkasan.md",
          content: "# Ringkasan\n- Rapat Senin jam 10 membahas harga kopi.\n- Stok gula habis, pesan 5 kg.\n- Promo akhir bulan: beli 2 gratis 1.\n",
        }),
      ),
      finalText("Selesai, ringkasan.md dibuat dari catatan.txt."),
    ],
  },

  // ---------- edge cases ----------
  {
    id: "edge-empty-file",
    category: "edge",
    title: "Baca file kosong",
    prompt: "Baca kosong.txt dan laporkan apa isinya.",
    setup: { "kosong.txt": "" },
    check: (ctx) =>
      ctx.status === "completed" && /kosong/i.test(ctx.summary)
        ? pass("agent melaporkan file kosong")
        : fail(`agent tidak melaporkan file kosong (status ${ctx.status}): "${ctx.summary.slice(0, 120)}"`),
    dummyScript: [
      withCalls(call("t1", "read_file", { path: "kosong.txt" })),
      finalText("File kosong.txt kosong, tidak ada isi."),
    ],
  },
  {
    id: "edge-missing-file",
    category: "edge",
    title: "Baca file yang tidak ada",
    prompt: "Baca file tidak-ada.txt dan laporkan isinya.",
    check: (ctx) => {
      if (ctx.filesCreated.length > 0)
        return fail(`agent membuat file padahal sumber tidak ada: ${ctx.filesCreated.join(", ")}`);
      return /tidak (ada|ditemukan|bisa dibaca)/i.test(ctx.summary)
        ? pass("agent jujur melaporkan file tidak ditemukan")
        : fail(`agent tidak melaporkan file tidak ditemukan: "${ctx.summary.slice(0, 120)}"`);
    },
    dummyScript: [
      withCalls(call("t1", "read_file", { path: "tidak-ada.txt" })),
      finalText("File tidak-ada.txt tidak ditemukan, jadi saya tidak bisa membacanya."),
    ],
  },
  {
    id: "edge-unicode",
    category: "edge",
    title: "Salin file unicode tanpa berubah",
    prompt: "Salin kutip.txt ke salinan.txt tanpa mengubah satu karakter pun.",
    setup: {
      "kutip.txt": `Dia berkata: "Halo 👋, kopi susu 1!" — selesai.\n`,
    },
    check: async (ctx) => {
      const src = await readText(ctx, "kutip.txt");
      const dst = await readText(ctx, "salinan.txt");
      if (dst === null) return fail("salinan.txt tidak dibuat");
      return dst === src
        ? pass("salinan.txt identik byte-per-byte (emoji, kutip, strip)")
        : fail("isi salinan.txt berubah");
    },
    dummyScript: [
      withCalls(call("t1", "read_file", { path: "kutip.txt" })),
      withCalls(
        call("t2", "write_file", {
          path: "salinan.txt",
          content: `Dia berkata: "Halo 👋, kopi susu 1!" — selesai.\n`,
        }),
      ),
      finalText("Selesai, salinan.txt identik dengan kutip.txt."),
    ],
  },

  // ---------- behaviour (near-human parity) ----------
  {
    id: "behavior-vague",
    category: "behavior",
    title: "Pesan samar: bertanya sebelum bertindak",
    prompt: "Buatkan yang bagus dong.",
    check: (ctx) =>
      askedBeforeMutating(ctx)
        ? pass("agent bertanya sebelum mengubah file", ASK_MANUAL)
        : fail("agent langsung bertindak tanpa bertanya dulu", ASK_MANUAL),
    dummyScript: [
      finalText("Boleh dijelaskan dulu? Mau dibuatkan apa — website, file, atau yang lain?"),
    ],
  },
  {
    id: "behavior-ambiguous",
    category: "behavior",
    title: "Instruksi ambigu: bertanya, bukan menebak",
    prompt: "Perbaiki file itu, fungsinya salah.",
    setup: {
      "a.js": "function hitung(x) { return x + 1; } // seharusnya x * 2\n",
      "b.js": "function total(x) { return x - 1; } // seharusnya x + 10\n",
    },
    check: (ctx) =>
      askedBeforeMutating(ctx)
        ? pass("agent bertanya file mana sebelum mengubah", ASK_MANUAL)
        : fail("agent menebak file tanpa bertanya (mengubah file dulu)", ASK_MANUAL),
    // INTENTIONALLY WRONG reference behaviour: guesses file a.js without
    // asking. Exists so the fail path of the proxy is exercised in CI.
    dummyScript: [
      withCalls(
        call("t1", "edit_file", {
          path: "a.js",
          old_str: "return x + 1;",
          new_str: "return x * 2;",
        }),
      ),
      finalText("Sudah diperbaiki."),
    ],
  },
  {
    id: "behavior-admit-mistake",
    category: "behavior",
    title: "Akui kesalahan saat dikoreksi",
    prompt: "Jawabanmu tadi salah. Perbaiki dan jelaskan jawaban yang benar.",
    history: [
      { role: "user", content: "Berapa 2+2?" },
      { role: "assistant", content: "5" },
    ],
    check: (ctx) => {
      const admits = /maaf|salah|keliru|kesalahan/i.test(ctx.summary);
      const correct = ctx.summary.includes("4");
      if (admits && correct)
        return pass("agent mengakui kesalahan dan memberi jawaban benar (4)", "Nada pengakuan dinilai manual dari log event.");
      if (!admits) return fail(`agent tidak mengakui kesalahan: "${ctx.summary.slice(0, 120)}"`);
      return fail("agent mengakui tapi jawaban benar (4) tidak ada");
    },
    dummyScript: [
      finalText("Maaf, jawaban saya salah. 2+2 = 4 karena 2 ditambah 2 sama dengan 4."),
    ],
  },
  {
    id: "behavior-explain-reason",
    category: "behavior",
    title: "Jelaskan alasan pendekatan",
    prompt:
      "Buatkan halaman sapaan sederhana (sapa.html) dan di ringkasan akhir jelaskan alasan pendekatannya.",
    check: async (ctx) => {
      const text = await readText(ctx, "sapa.html");
      if (text === null) return fail("sapa.html tidak dibuat");
      return summaryStatesReason(ctx.summary)
        ? pass("sapa.html dibuat dan ringkasan menyebut alasan", "Kualitas alasan dinilai manual dari log event.")
        : fail(`ringkasan tidak menyebut alasan: "${ctx.summary.slice(0, 120)}"`);
    },
    dummyScript: [
      withCalls(
        call("t1", "write_file", {
          path: "sapa.html",
          content: "<!doctype html><html><body><h1>Halo!</h1></body></html>\n",
        }),
      ),
      finalText("Selesai. Saya memakai HTML polos tanpa framework karena tugasnya sederhana dan supaya cepat dibuka."),
    ],
  },
  {
    id: "behavior-remember-context",
    category: "behavior",
    title: "Ingat konteks percakapan",
    prompt: "Buatkan halaman sapaan untukku dengan warna favoritku.",
    history: [
      { role: "user", content: "Namaku Rizqi, warna favoritku biru." },
      { role: "assistant", content: "Siap, Rizqi! Akan kuingat warna favoritmu biru." },
    ],
    check: async (ctx) => {
      const text = await readText(ctx, "index.html");
      if (text === null) return fail("index.html tidak dibuat");
      const hasName = text.includes("Rizqi");
      const hasColor = /biru|blue/i.test(text);
      if (hasName && hasColor) return pass("halaman memakai nama Rizqi dan warna biru");
      return fail(`halaman tidak memakai konteks (nama: ${hasName}, warna: ${hasColor})`);
    },
    dummyScript: [
      withCalls(
        call("t1", "write_file", {
          path: "index.html",
          content: `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><title>Halo Rizqi</title>
<style>body { background: blue; color: white; }</style></head>
<body><h1>Halo Rizqi!</h1><p>Halaman sapaan dengan warna favoritmu, biru.</p></body></html>
`,
        }),
      ),
      finalText("Selesai. Halaman memakai nama Rizqi dan warna biru karena itu yang kamu sebut sebelumnya."),
    ],
  },
];

export function getTask(id: string): EvalTask | undefined {
  return TASKS.find((t) => t.id === id);
}

/**
 * Fase 5 plan-first: the loop discards a first response's tool calls
 * unless it contains an `update_plan` call (it nudges once instead).
 * A scripted dummy must therefore open with a plan, or its first step
 * silently vanishes. Prepend a one-item plan call to the first scripted
 * response that carries tool calls; responses that only answer in text
 * need no plan.
 */
export function planFirstScript(task: EvalTask): ChatResult[] {
  const script = task.dummyScript ?? [];
  const idx = script.findIndex((r) => r.toolCalls.length > 0);
  if (idx < 0) return script;
  if (script[idx].toolCalls.some((c) => c.function.name === "update_plan"))
    return script;
  const plan: ToolCallReq = {
    id: "t0-plan",
    type: "function",
    function: {
      name: "update_plan",
      arguments: JSON.stringify({
        items: [{ text: task.title, status: "doing" }],
      }),
    },
  };
  return script.map((r, i) =>
    i === idx ? { ...r, toolCalls: [plan, ...r.toolCalls] } : r,
  );
}
