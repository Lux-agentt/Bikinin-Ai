// Delegate tool (Fase 5): the main agent hands ONE focused research task
// to a subagent (see src/agent/subagent.ts). The subagent has its own
// step/cost budget and read-only tools; only a compact summary comes back.
// Use only when parallel research genuinely helps — never for trivial tasks
// the main agent can do directly, because the subagent burns the same
// provider quota (OpenRouter gratis: 50 request/hari per akun).
import { z } from "zod";
import { defineTool } from "./types.js";

export const delegateTool = defineTool({
  name: "delegate",
  description:
    "Delegasikan SATU tugas riset spesifik ke subagent (baca file, baca skill, cari di internet) dan terima ringkasannya. Subagent tidak boleh menulis file. Pakai hanya bila riset paralel benar-benar membantu; JANGAN untuk tugas sepele yang bisa dikerjakan langsung — subagent memakai kuota provider yang sama (OpenRouter gratis: 50 request/hari per akun).",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description:
          "Tugas spesifik untuk subagent, satu hal saja, maks 2000 karakter",
      },
      context: {
        type: "string",
        description:
          "Konteks singkat dari run utama (rencana, file relevan), maks 2000 karakter",
      },
    },
    required: ["task"],
    additionalProperties: false,
  },
  readOnly: false,
  schema: z.object({
    task: z.string().min(1).max(2000),
    context: z.string().max(2000).optional(),
  }),
  label: (a) => `delegate: ${a.task.slice(0, 80)}`,
  publicArgs: (a) => ({ task: a.task.slice(0, 200) }),
  async run(a, ctx) {
    if (!ctx.delegate) {
      return {
        ok: false,
        summary: "subagent tidak tersedia",
        output:
          "ERROR: subagent tidak tersedia di run ini. Kerjakan tugasnya langsung.",
        changes: [],
      };
    }
    const r = await ctx.delegate(a.task, a.context);
    return {
      ok: r.status === "completed",
      summary: `subagent: ${r.status} (${r.steps} langkah, $${r.costUsd.toFixed(4)})`,
      output: r.summary,
      changes: [],
    };
  },
});
