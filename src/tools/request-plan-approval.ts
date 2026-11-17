// Plan mode (Fase 6, Track D): for a big task the model writes a plan with
// update_plan, then calls this tool to ask the user to approve it BEFORE
// changing any file. The loop intercepts this tool: it emits the existing
// approval_requested / approval_resolved events, and until the plan is
// approved it blocks every file-changing tool; on deny the run stops
// without changing files. The tool itself only carries the plan summary —
// the gating lives in src/agent/loop.ts.
import { z } from "zod";
import { defineTool } from "./types.js";

export const requestPlanApprovalTool = defineTool({
  name: "request_plan_approval",
  description:
    "Minta persetujuan pengguna atas rencana kerja (tulis dulu dengan update_plan) SEBELUM mengubah file apa pun. Pakai untuk tugas besar: setelah rencana disetujui baru kerjakan; bila ditolak, run berhenti tanpa mengubah file. Argumen: ringkasan rencana + daftar file yang akan diubah.",
  parameters: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description:
          "Ringkasan rencana (maks 1000 karakter): apa yang akan dibuat/diubah dan kenapa.",
      },
      files: {
        type: "array",
        items: { type: "string" },
        description: "File yang rencananya dibuat/diubah (path relatif).",
      },
    },
    required: ["summary"],
    additionalProperties: false,
  },
  readOnly: true,
  schema: z.object({
    summary: z.string().trim().min(1).max(1000),
    files: z.array(z.string().min(1).max(500)).max(50).default([]),
  }),
  label: () => "request_plan_approval",
  publicArgs: (a) => ({
    summary: a.summary,
    ...(a.files.length > 0 ? { files: a.files } : {}),
  }),
  async run(a) {
    // The loop replaces this result with the real approval outcome; a
    // direct call (tests, helpers) reports the plan as presented.
    const files = a.files.length > 0 ? ` File: ${a.files.join(", ")}.` : "";
    return {
      ok: true,
      summary: `rencana diajukan untuk persetujuan: ${a.summary.slice(0, 120)}`,
      output: `Rencana:\n${a.summary}${files}`,
      changes: [],
    };
  },
});
