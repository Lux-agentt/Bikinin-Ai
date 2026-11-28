// Unit tests: transcript Markdown builder (pure function over SessionDetail).
import { describe, expect, it } from "vitest";
import { AgentEvent } from "../src/events.js";
import type { SessionDetail } from "../src/server/runs.js";
import {
  buildTranscript,
  transcriptFilename,
} from "../src/server/transcript.js";

function ev(
  seq: number,
  type: string,
  extra: Record<string, unknown>,
): AgentEvent {
  return AgentEvent.parse({
    v: 1,
    seq,
    ts: "2026-11-27T16:00:00.000Z",
    run_id: "run_aaaa0001",
    type,
    ...extra,
  });
}

function detail(
  runs: SessionDetail["runs"],
  title = "Buat halaman",
): SessionDetail {
  return {
    session_id: "s_aaaa0001",
    title,
    prompts: 1,
    updated_at: Date.parse("2026-11-27T16:30:00.000Z"),
    runs,
  };
}

const started = (seq: number) =>
  ev(seq, "run_started", {
    session_id: "s_aaaa0001",
    model: "test-model",
    effort: "sedang",
    user_message: "buat halaman",
    limits: { max_cost_usd: 1 },
  });

const finished = (seq: number, status = "completed") =>
  ev(seq, "run_finished", {
    status,
    summary: "Selesai.",
    totals: {
      steps: 2,
      input_tokens: 100,
      output_tokens: 20,
      cached_tokens: 0,
      cost_usd: 0.0001,
    },
    duration_ms: 1500,
    resumable: false,
  });

describe("buildTranscript", () => {
  it("merangkai pesan user, teks agent, dan ringkasan run secara kronologis", () => {
    const md = buildTranscript(
      detail([
        {
          run_id: "run_aaaa0001",
          events: [
            started(0),
            ev(1, "text_delta", { text: "Halo, " }),
            ev(2, "text_delta", { text: "ini hasilnya." }),
            finished(3),
          ],
        },
      ]),
    );
    expect(md).toContain("# Buat halaman");
    expect(md).toContain("## Run 1 — test-model");
    expect(md).toContain("**Pengguna:** buat halaman");
    expect(md).toContain("**Agent:** Halo, ini hasilnya.");
    expect(md).toContain("**Selesai:** completed — Selesai.");
    expect(md).toContain("Langkah: 2");
    expect(md.indexOf("**Pengguna:**")).toBeLessThan(
      md.indexOf("**Agent:**"),
    );
    expect(md.indexOf("**Agent:**")).toBeLessThan(
      md.indexOf("**Selesai:**"),
    );
  });

  it("tool call menampilkan label, hasil, dan output yang dipotong", () => {
    const md = buildTranscript(
      detail([
        {
          run_id: "run_aaaa0001",
          events: [
            started(0),
            ev(1, "tool_call_started", {
              call_id: "c1",
              step: 1,
              tool: "write_file",
              label: "write_file index.html",
              args: { path: "index.html" },
            }),
            ev(2, "tool_call_finished", {
              call_id: "c1",
              ok: true,
              summary: "index.html ditulis",
              output_preview: "x".repeat(5000),
              truncated: true,
              duration_ms: 1300,
            }),
            finished(3),
          ],
        },
      ]),
    );
    expect(md).toContain("### Langkah 1 — write_file index.html");
    expect(md).toContain("- Tool: `write_file`");
    expect(md).toContain("- Hasil: OK — index.html ditulis");
    expect(md).toContain("… (dipotong)");
    expect(md).not.toContain("x".repeat(5000));
  });

  it("verifikasi gagal dan error run ditampilkan", () => {
    const md = buildTranscript(
      detail([
        {
          run_id: "run_aaaa0001",
          events: [
            started(0),
            ev(1, "verification", {
              outcome: "fail",
              checks: [
                { name: "file ada", ok: true, detail: "ok" },
                { name: "judul benar", ok: false, detail: "tidak ada h1" },
              ],
              fixes: 1,
            }),
            ev(2, "error", {
              code: "tool_failed",
              message: "gagal nulis",
              retryable: false,
            }),
            finished(3, "error"),
          ],
        },
      ]),
    );
    expect(md).toContain("**Verifikasi:** gagal (putaran perbaikan: 1)");
    expect(md).toContain("- ✓ file ada: ok");
    expect(md).toContain("- ✗ judul benar: tidak ada h1");
    expect(md).toContain("**Error (tool_failed):** gagal nulis");
    expect(md).toContain("**Selesai:** error");
  });

  it("tool yang tidak selesai ditandai; sesi dan run kosong ditangani", () => {
    const md = buildTranscript(
      detail([
        {
          run_id: "run_aaaa0001",
          events: [
            started(0),
            ev(1, "tool_call_started", {
              call_id: "c1",
              step: 1,
              tool: "run_command",
              label: "$ npm install",
              args: { command: "npm install" },
            }),
          ],
        },
        { run_id: "run_aaaa0002", events: [] },
      ]),
    );
    expect(md).toContain("### Langkah 1 — $ npm install");
    expect(md).toContain("belum selesai");
    expect(md).toContain("(Tidak ada kejadian terekam untuk run ini.)");
    expect(buildTranscript(detail([]))).toContain(
      "(Belum ada run di sesi ini.)",
    );
  });
});

describe("transcriptFilename", () => {
  it("nama file dari judul, dibersihkan dari karakter berbahaya", () => {
    expect(transcriptFilename(detail([], 'Buat "halaman"/baru'))).toBe(
      "Buat halamanbaru.md",
    );
    expect(transcriptFilename(detail([], ""))).toBe("s_aaaa0001.md");
    expect(transcriptFilename(detail([], "   "))).toBe("s_aaaa0001.md");
  });
});
