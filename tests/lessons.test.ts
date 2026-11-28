import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatCompletionMessageParam as Msg } from "openai/resources/chat/completions";
import {
  buildLessonsContext,
  deriveSignals,
  extractLessons,
  extractLessonsWithModel,
  formatLessons,
  LESSONS_INJECT_BUDGET,
  LESSONS_MAX_BYTES,
  mergeLessons,
  parseLessons,
  selectLessons,
  type FreshLesson,
} from "../src/agent/lessons.js";
import {
  appendLessons,
  lessonsFilePath,
  readLessonEntries,
} from "../src/server/persistence.js";

const user = (content: string): Msg => ({ role: "user", content });

const asstTool = (id: string, tool: string, args: string): Msg =>
  ({
    role: "assistant",
    content: null,
    tool_calls: [
      { id, type: "function", function: { name: tool, arguments: args } },
    ],
  }) as Msg;

const toolMsg = (id: string, content: string): Msg =>
  ({ role: "tool", tool_call_id: id, content }) as Msg;

function lesson(over: Partial<FreshLesson> & { date?: string }) {
  return {
    date: over.date ?? "2026-11-18",
    task: over.task ?? "baca file konfigurasi",
    gagal: over.gagal ?? "read_file gagal: file tidak ditemukan",
    berhasil: over.berhasil ?? "",
    aturan:
      over.aturan ??
      "Jika read_file gagal 2× dengan cara yang sama, berhenti mengulang.",
  };
}

describe("extractLessons (rule-based, no model call)", () => {
  it("records one lesson when the same tool fails twice", () => {
    const lessons = extractLessons(
      [
        user("baca file config-yang-hilang.json"),
        asstTool("c1", "read_file", '{"path":"config-yang-hilang.json"}'),
        toolMsg(
          "c1",
          "ERROR: ENOENT: no such file or directory, stat 'config-yang-hilang.json'",
        ),
        asstTool("c2", "read_file", '{"path":"config-yang-hilang.json"}'),
        toolMsg(
          "c2",
          "ERROR: ENOENT: no such file or directory, stat 'config-yang-hilang.json'",
        ),
      ],
      "File tidak ditemukan, saya berhenti.",
      "completed",
    );
    expect(lessons).toHaveLength(1);
    expect(lessons[0].task).toContain("config-yang-hilang");
    expect(lessons[0].gagal).toContain("read_file gagal 2×");
    expect(lessons[0].aturan).toContain("berhenti mengulang");
  });

  it("records nothing for a clean run or a single fixed failure", () => {
    // Clean run: no tool failures at all.
    expect(
      extractLessons(
        [
          user("buat halaman"),
          asstTool("c1", "write_file", '{"path":"index.html"}'),
          toolMsg("c1", "OK: index.html ditulis (8,4 KB)"),
        ],
        "Selesai.",
        "completed",
      ),
    ).toEqual([]);
    // One failure, fixed immediately by retrying the SAME tool: normal
    // self-correction, not a lesson (no workaround learned).
    expect(
      extractLessons(
        [
          user("buat halaman"),
          asstTool("c1", "read_file", '{"path":"a.html"}'),
          toolMsg("c1", "ERROR: file tidak ditemukan"),
          asstTool("c2", "read_file", '{"path":"a.html"}'),
          toolMsg("c2", "OK: a.html (12 baris)"),
        ],
        "Selesai.",
        "completed",
      ),
    ).toEqual([]);
  });

  it("records a lesson when the user corrects the previous result", () => {
    const lessons = extractLessons(
      [
        user("tampilan dichatnya kurang bagus, harusnya simpel aja"),
        asstTool("c1", "edit_file", '{"path":"public/app.css"}'),
        toolMsg("c1", "OK: app.css diubah"),
      ],
      "Tampilan diperbaiki.",
      "completed",
    );
    expect(lessons).toHaveLength(1);
    expect(lessons[0].task).toContain("tampilan dichatnya kurang bagus");
    expect(lessons[0].aturan).toContain("Perhatikan koreksi pengguna");
  });

  it("records no correction lesson for a plain request or a failed run", () => {
    // Plain request, no correction language: clean run teaches nothing.
    expect(
      extractLessons(
        [
          user("buatkan landing page kopi estetik"),
          asstTool("c1", "write_file", '{"path":"index.html"}'),
          toolMsg("c1", "OK: index.html ditulis"),
        ],
        "Selesai.",
        "completed",
      ),
    ).toEqual([]);
    // Correction language but the run errored: the correction was not
    // carried out, so only the error lesson is kept.
    const errorLessons = extractLessons(
      [user("tampilan dichatnya kurang bagus, benerin dong")],
      "Run berakhir error.",
      "error",
    );
    expect(errorLessons).toHaveLength(1);
    expect(errorLessons[0].gagal).toContain("Run berakhir error");
  });

  it("records the workaround when a different tool fixes the failure", () => {
    const lessons = extractLessons(
      [
        user("baca isi file besar"),
        asstTool("c1", "read_file", '{"path":"besar.txt"}'),
        toolMsg("c1", "GAGAL: besar.txt terlalu besar (3000000 B)"),
        asstTool("c2", "run_command", '{"command":"head -n 200 besar.txt"}'),
        toolMsg("c2", "OK: 200 baris pertama ditampilkan"),
      ],
      "Selesai membaca sebagian file.",
      "completed",
    );
    expect(lessons).toHaveLength(1);
    expect(lessons[0].gagal).toContain("read_file gagal");
    expect(lessons[0].berhasil).toContain("run_command berhasil");
    expect(lessons[0].aturan).toContain("run_command");
  });

  it("records a lesson when the run ends budget_exceeded or error", () => {
    const budget = extractLessons(
      [user("buatkan website toko lengkap dengan 10 halaman")],
      "Berhenti: batas langkah tercapai.",
      "budget_exceeded",
      { steps: 30 },
    );
    expect(budget).toHaveLength(1);
    expect(budget[0].gagal).toContain("kehabisan langkah/biaya");
    expect(budget[0].gagal).toContain("30 langkah");
    expect(budget[0].aturan).toContain("rencana maks 5 langkah");

    const errored = extractLessons(
      [
        user("deploy"),
        asstTool("c1", "run_command", '{"command":"npm run build"}'),
        toolMsg("c1", "ERROR: build gagal: modul tidak ditemukan"),
      ],
      "Run berhenti karena error.",
      "error",
    );
    expect(errored).toHaveLength(1);
    expect(errored[0].gagal).toContain("berakhir error");
    expect(errored[0].aturan).toContain("baca pesan errornya");
  });

  it("never records secrets, even inside a tool error", () => {
    const lessons = extractLessons(
      [
        user("cek kunci"),
        asstTool("c1", "read_file", '{"path":"kunci.txt"}'),
        toolMsg("c1", "ERROR: isi file: sk-abcdefghijklmnopqrstuvwx"),
        asstTool("c2", "read_file", '{"path":"kunci.txt"}'),
        toolMsg("c2", "ERROR: isi file: sk-abcdefghijklmnopqrstuvwx"),
      ],
      "Gagal.",
      "completed",
    );
    expect(lessons).toEqual([]);
  });

  it("stores only the first line of a tool error, never the raw output", () => {
    const lessons = extractLessons(
      [
        user("baca file rahasia"),
        asstTool("c1", "read_file", '{"path":"x.txt"}'),
        toolMsg(
          "c1",
          "ERROR: baris pertama\nbaris kedua token-abc\nbaris ketiga",
        ),
        asstTool("c2", "read_file", '{"path":"x.txt"}'),
        toolMsg(
          "c2",
          "ERROR: baris pertama\nbaris kedua token-abc\nbaris ketiga",
        ),
      ],
      "Gagal.",
      "completed",
    );
    expect(lessons).toHaveLength(1);
    expect(lessons[0].gagal).toContain("baris pertama");
    expect(lessons[0].gagal).not.toContain("baris kedua");
  });
});

describe("deriveSignals", () => {
  it("counts tool outcomes from the transcript", () => {
    const signals = deriveSignals([
      asstTool("c1", "read_file", "{}"),
      toolMsg("c1", "ERROR: gagal"),
      asstTool("c2", "write_file", "{}"),
      toolMsg("c2", "OK: selesai"),
    ]);
    expect(signals.steps).toBe(2);
    expect(signals.failedToolCalls).toBe(1);
  });
});

describe("lessons file format", () => {
  it("round-trips through format/parse and drops secret lines", () => {
    const entries = [lesson({}), lesson({ date: "2026-11-17" })];
    const text = formatLessons(entries);
    expect(text).toContain("# Pelajaran Bikinin AI");
    expect(text).toContain(
      "- [2026-11-18] Tugas: baca file konfigurasi | Gagal: read_file gagal",
    );
    expect(
      parseLessons(
        `${text}- [2026-11-15] Tugas: x | Gagal: y | Berhasil:  | Aturan: key sk-abcdefghijklmnopqrstuvwx\n`,
      ),
    ).toHaveLength(2);
  });

  it("merges without duplicates and caps the file at 32 KB", () => {
    const existing = [lesson({ date: "2026-11-10" })];
    const fresh: FreshLesson[] = [
      {
        task: "baca file konfigurasi",
        gagal: "read_file gagal: file tidak ditemukan",
        berhasil: "",
        aturan:
          "Jika read_file gagal 2× dengan cara yang sama, berhenti mengulang.",
      }, // exact duplicate rule
      {
        task: "render video",
        gagal: "render_video gagal: ffmpeg tidak ditemukan",
        berhasil: "",
        aturan: "Jika render_video gagal, cek ffmpeg terpasang dulu.",
      },
    ];
    const merged = mergeLessons(existing, fresh, "2026-11-18");
    expect(merged.map((e) => e.aturan)).toEqual([
      "Jika render_video gagal, cek ffmpeg terpasang dulu.",
      "Jika read_file gagal 2× dengan cara yang sama, berhenti mengulang.",
    ]);

    // Flood with long lessons: the merged file must stay within the cap,
    // keeping the newest entries.
    const flood: FreshLesson[] = Array.from({ length: 300 }, (_, i) => ({
      task: `tugas ${i}`,
      gagal: `gagal ${i} `.repeat(20),
      berhasil: "",
      aturan: `aturan nomor ${i} `.repeat(15),
    }));
    const capped = mergeLessons([], flood, "2026-11-18");
    const bytes = Buffer.byteLength(formatLessons(capped), "utf8");
    expect(bytes).toBeLessThanOrEqual(LESSONS_MAX_BYTES);
    expect(capped[0].aturan).toContain("aturan nomor 299");
  });
});

describe("selectLessons / buildLessonsContext (prompt injection)", () => {
  const entries = [
    lesson({ date: "2026-11-18" }),
    lesson({
      date: "2026-11-17",
      task: "render video intro",
      gagal: "render_video gagal: durasi melebihi batas",
      berhasil: "",
      aturan: "Jika render_video gagal, turunkan durasi di bawah batas.",
    }),
  ];

  it("picks only lessons whose keywords overlap the request", () => {
    const picked = selectLessons(
      entries,
      "tolong baca file konfigurasi yang hilang",
    );
    expect(picked).toHaveLength(1);
    expect(picked[0].task).toContain("konfigurasi");
    expect(selectLessons(entries, "buatkan video animasi")).toHaveLength(1);
    expect(selectLessons(entries, "buatkan logo baru")).toEqual([]);
    expect(selectLessons(entries, "")).toEqual([]);
  });

  it("respects a small char budget, best match first", () => {
    const picked = selectLessons(
      entries,
      "baca file konfigurasi render video",
      100,
    );
    expect(picked.length).toBeGreaterThanOrEqual(1);
    for (const p of picked) {
      expect(p.task.length + p.gagal.length).toBeLessThanOrEqual(400);
    }
    const ctx = buildLessonsContext(entries, "baca file konfigurasi");
    expect(ctx).toContain("Pelajaran dari run sebelumnya");
    expect(ctx).toContain("read_file gagal");
    expect(ctx.length).toBeLessThanOrEqual(LESSONS_INJECT_BUDGET + 200);
  });

  it("returns empty when nothing matches", () => {
    expect(buildLessonsContext(entries, "buatkan logo baru")).toBe("");
    expect(buildLessonsContext([], "baca file")).toBe("");
  });
});

describe("persistence on disk", () => {
  async function tmpWs() {
    return mkdtemp(join(tmpdir(), "bikinin-lessons-"));
  }

  it("appends lessons to lessons.md, dedupes, and writes nothing when empty", async () => {
    const ws = await tmpWs();
    expect(await appendLessons(ws, [])).toBe(0);
    await expect(readFile(lessonsFilePath(ws), "utf8")).rejects.toThrow();
    const added = await appendLessons(ws, [
      {
        task: "baca file",
        gagal: "read_file gagal 2×: tidak ditemukan",
        berhasil: "",
        aturan: "Jika read_file gagal 2×, berhenti mengulang.",
      },
      {
        task: "cek kunci",
        gagal: "gagal: sk-abcdefghijklmnopqrstuvwx",
        berhasil: "",
        aturan: "aturan dengan sk-abcdefghijklmnopqrstuvwx",
      },
    ]);
    expect(added).toBe(1); // the secret lesson is dropped
    const text = await readFile(lessonsFilePath(ws), "utf8");
    expect(text).toContain("read_file gagal 2×");
    expect(text).not.toContain("sk-");
    expect(
      await appendLessons(ws, [
        {
          task: "baca file",
          gagal: "read_file gagal 2×: tidak ditemukan",
          berhasil: "",
          aturan: "Jika read_file gagal 2×, berhenti mengulang.",
        },
      ]),
    ).toBe(0);
    expect(await readLessonEntries(ws)).toHaveLength(1);
  });
});

describe("extractLessonsWithModel (auto-learn, satu panggilan :free)", () => {
  // Run render_video yang gagal 3x karena Root.tsx tidak mendaftarkan
  // komposisi — pelajaran aturan cuma bilang "coba edit_file", sedangkan
  // model menulis penyebab akarnya.
  const failingTranscript: Msg[] = [
    user("render video Scene6"),
    asstTool("c1", "render_video", JSON.stringify({ project: "rizqi-scene-new" })),
    toolMsg("c1", "GAGAL: npx remotion compositions gagal (exit 1):"),
    asstTool("c2", "render_video", JSON.stringify({ project: "rizqi-scene-new" })),
    toolMsg("c2", "GAGAL: npx remotion compositions gagal (exit 1):"),
    asstTool("c3", "render_video", JSON.stringify({ project: "rizqi-scene-new" })),
    toolMsg("c3", "GAGAL: npx remotion compositions gagal (exit 1):"),
  ];

  it("parses a well-formed model reply into a lesson with the root cause", async () => {
    let seenPrompt = "";
    const lessons = await extractLessonsWithModel(
      failingTranscript,
      "render gagal",
      "error",
      {
        enabled: true,
        freeModel: "nvidia/nemotron-3.5-super-vl:free",
        callFreeModel: async (prompt) => {
          seenPrompt = prompt;
          return "Tugas: render video Scene6 | Gagal: render_video gagal 3×: npx remotion compositions gagal (exit 1) — 0 komposisi terdaftar | Berhasil:  | Aturan: Root.tsx harus me-render <Composition id=\"Scene6\" component={Scene6} ... />; tanpa itu Remotion menemukan 0 komposisi dan render selalu gagal.";
        },
      },
    );
    expect(seenPrompt).toContain("render_video");
    expect(seenPrompt).toContain("compositions gagal");
    expect(lessons).toHaveLength(1);
    expect(lessons[0].aturan).toContain("Composition");
    expect(lessons[0].aturan).toContain("Root.tsx");
  });

  it("ignores garbage lines and secret lines, caps at 3 lessons", async () => {
    const lessons = await extractLessonsWithModel(
      failingTranscript,
      "render gagal",
      "error",
      {
        enabled: true,
        freeModel: "google/gemma-4-31b-it:free",
        callFreeModel: async () =>
          [
            "ini bukan pelajaran",
            "Tugas: render video satu | Gagal: render_video gagal sekali | Berhasil:  | Aturan: aturan satu yang benar dan panjang",
            "Tugas: render video dua | Gagal: render_video gagal dua kali | Berhasil:  | Aturan: kunci sk-abcdef1234567890",
            "Tugas: render video tiga | Gagal: render_video gagal tiga kali | Berhasil:  | Aturan: aturan tiga yang benar dan panjang",
            "Tugas: render video empat | Gagal: render_video gagal empat kali | Berhasil:  | Aturan: aturan empat yang benar dan panjang",
            "Tugas: render video lima | Gagal: render_video gagal lima kali | Berhasil:  | Aturan: aturan lima yang benar dan panjang",
          ].join("\n"),
      },
    );
    expect(lessons).toHaveLength(3);
    expect(lessons.map((l) => l.task)).toEqual([
      "render video satu",
      "render video tiga",
      "render video empat",
    ]);
    expect(JSON.stringify(lessons)).not.toContain("sk-");
  });

  it("never calls the model when disabled, unpaid, or nothing to learn", async () => {
    const clean: Msg[] = [user("halo"), { role: "assistant", content: "hai" }];
    let calls = 0;
    const spy = async () => {
      calls += 1;
      return "";
    };
    expect(
      await extractLessonsWithModel(failingTranscript, "x", "error", {
        enabled: false,
        freeModel: "nvidia/nemotron-3.5-super-vl:free",
        callFreeModel: spy,
      }),
    ).toEqual([]);
    expect(
      await extractLessonsWithModel(failingTranscript, "x", "error", {
        enabled: true,
        freeModel: "anthropic/claude-haiku-4.5",
        callFreeModel: spy,
      }),
    ).toEqual([]);
    expect(
      await extractLessonsWithModel(clean, "x", "completed", {
        enabled: true,
        freeModel: "nvidia/nemotron-3.5-super-vl:free",
        callFreeModel: spy,
      }),
    ).toEqual([]);
    expect(calls).toBe(0);
  });

  it("returns [] when the model call fails", async () => {
    const lessons = await extractLessonsWithModel(
      failingTranscript,
      "render gagal",
      "error",
      {
        enabled: true,
        freeModel: "nvidia/nemotron-3.5-super-vl:free",
        callFreeModel: async () => {
          throw new Error("429 quota habis");
        },
      },
    );
    expect(lessons).toEqual([]);
  });
});
