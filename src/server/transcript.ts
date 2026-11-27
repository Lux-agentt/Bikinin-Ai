// Builds a readable Markdown transcript of one session from its recorded
// events (the same SessionDetail behind GET /api/sessions/:id). Pure
// function: no I/O, so the route and the tests share it.
import type { AgentEvent } from "../events.js";
import type { SessionDetail } from "./runs.js";

/** Tool output shown in full up to this length; longer output is cut. */
const MAX_OUTPUT_CHARS = 2000;
/** Tool arguments are a hint, not the record: one short line at most. */
const MAX_ARGS_CHARS = 300;
/** Long titles make awkward filenames. */
const MAX_FILENAME_CHARS = 80;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "… (dipotong)";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} dtk`;
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

/** Filename for the download: the session title, or its id when the title
 *  is empty/unsafe. Only header-breaking and path characters are stripped;
 *  the rest (including spaces and Indonesian letters) is kept. */
export function transcriptFilename(detail: SessionDetail): string {
  const clean = detail.title
    .replace(/["\r\n/\\:*?<>|\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FILENAME_CHARS);
  return `${clean || detail.session_id}.md`;
}

export function buildTranscript(detail: SessionDetail): string {
  const lines: string[] = [];
  lines.push(`# ${detail.title || detail.session_id}`);
  lines.push("");
  lines.push(`- Sesi: \`${detail.session_id}\``);
  lines.push(`- Diperbarui: ${new Date(detail.updated_at).toISOString()}`);
  lines.push(`- Jumlah run: ${detail.runs.length}`);
  lines.push("");
  if (detail.runs.length === 0) {
    lines.push("(Belum ada run di sesi ini.)");
    lines.push("");
    return lines.join("\n");
  }
  detail.runs.forEach((run, i) => renderRun(lines, run, i + 1));
  return lines.join("\n");
}

interface StartedCall {
  step: number;
  tool: string;
  label: string;
  args: string;
}

function renderRun(
  lines: string[],
  run: { run_id: string; events: AgentEvent[] },
  index: number,
): void {
  const events = [...run.events].sort((a, b) => a.seq - b.seq);
  const started = events.find((e) => e.type === "run_started");
  const model = started?.type === "run_started" ? started.model : "?";
  lines.push(`## Run ${index} — ${model}`);
  lines.push("");
  if (started?.type === "run_started") {
    lines.push(`- Dimulai: ${started.ts}`);
    lines.push(`- Run: \`${run.run_id}\``);
    lines.push("");
    lines.push(`**Pengguna:** ${started.user_message}`);
    lines.push("");
  }
  if (events.length === 0) {
    lines.push("(Tidak ada kejadian terekam untuk run ini.)");
    lines.push("");
    return;
  }
  let textBuf = "";
  const flushText = () => {
    const text = textBuf.trim();
    textBuf = "";
    if (!text) return;
    lines.push(`**Agent:** ${text}`);
    lines.push("");
  };
  const open = new Map<string, StartedCall>();
  for (const e of events) {
    switch (e.type) {
      case "text_delta":
        textBuf += e.text;
        break;
      case "tool_call_started": {
        flushText();
        open.set(e.call_id, {
          step: e.step,
          tool: e.tool,
          label: e.label,
          args: truncate(JSON.stringify(e.args), MAX_ARGS_CHARS),
        });
        const c = open.get(e.call_id)!;
        lines.push(`### Langkah ${c.step} — ${c.label}`);
        lines.push("");
        lines.push(`- Tool: \`${c.tool}\``);
        lines.push(`- Argumen: \`${c.args}\``);
        break;
      }
      case "tool_call_finished": {
        flushText();
        const c = open.get(e.call_id);
        if (!c) {
          lines.push(`### Langkah ? — ${e.call_id}`);
          lines.push("");
        }
        open.delete(e.call_id);
        lines.push(
          `- Hasil: ${e.ok ? "OK" : "GAGAL"} — ${e.summary} (${formatDuration(e.duration_ms)})`,
        );
        if (e.output_preview)
          lines.push(
            `- Output: ${truncate(e.output_preview.replace(/\s+/g, " "), MAX_OUTPUT_CHARS)}`,
          );
        lines.push("");
        break;
      }
      case "verification": {
        flushText();
        lines.push(
          `**Verifikasi:** ${e.outcome === "pass" ? "lolos" : "gagal"} (putaran perbaikan: ${e.fixes})`,
        );
        for (const check of e.checks)
          lines.push(
            `- ${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`,
          );
        lines.push("");
        break;
      }
      case "error":
        flushText();
        lines.push(`**Error (${e.code}):** ${e.message}`);
        lines.push("");
        break;
      case "run_finished": {
        flushText();
        lines.push(`**Selesai:** ${e.status} — ${e.summary}`);
        lines.push(
          `- Langkah: ${e.totals.steps} · Token: ${e.totals.input_tokens} masuk / ${e.totals.output_tokens} keluar · Biaya: ${formatCost(e.totals.cost_usd)} · Durasi: ${formatDuration(e.duration_ms)}`,
        );
        lines.push("");
        break;
      }
      default:
        // run_started, plan_updated, file_changed, usage, dsb. bukan isi
        // transkrip: pesannya sudah tercakup di blok di atas.
        break;
    }
  }
  // Tool yang mulai tapi tidak pernah selesai: run berhenti di tengahnya.
  // Headernya sudah tampil saat tool mulai, jadi catatan ini cukup
  // menandai langkah mana yang tidak selesai.
  for (const c of open.values()) {
    lines.push(
      `- Hasil: belum selesai — Langkah ${c.step} (${c.label}) berhenti di tengah tool`,
    );
  }
  if (open.size > 0) lines.push("");
  flushText();
}
