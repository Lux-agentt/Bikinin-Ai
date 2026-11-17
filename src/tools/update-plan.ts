// Plan tool (Fase 5): the model writes a short plan (max 5 steps) BEFORE its
// first tool call. The loop turns a successful call into a `plan_updated`
// event, which the UI renders as the Todo panel. Calling it again updates
// the plan (status per step); the loop keeps step ids stable by matching
// on the step text.
import { z } from "zod";
import { defineTool } from "./types.js";

export const PLAN_MAX_ITEMS = 5;

export const updatePlanTool = defineTool({
  name: "update_plan",
  description:
    "Tulis atau perbarui rencana kerja singkat (maks 5 langkah) untuk tugas ini. WAJIB dipanggil SEBELUM tool lain di awal run, dan dipanggil lagi setiap satu langkah selesai atau rencana berubah. Tiap langkah: teks singkat + status (pending/doing/done).",
  parameters: {
    type: "object",
    properties: {
      items: {
        type: "array",
        minItems: 1,
        maxItems: PLAN_MAX_ITEMS,
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: "Satu langkah, singkat" },
            status: {
              type: "string",
              enum: ["pending", "doing", "done"],
            },
          },
          required: ["text", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
  readOnly: true,
  schema: z.object({
    items: z
      .array(
        z.object({
          text: z.string().min(1).max(200),
          status: z.enum(["pending", "doing", "done"]),
        }),
      )
      .min(1)
      .max(PLAN_MAX_ITEMS),
  }),
  label: () => "update_plan",
  publicArgs: (a) => ({
    items: a.items.map((i) => ({ text: i.text, status: i.status })),
  }),
  async run(a) {
    const done = a.items.filter((i) => i.status === "done").length;
    return {
      ok: true,
      summary: `rencana: ${done}/${a.items.length} selesai`,
      output: a.items
        .map(
          (i) =>
            `- [${i.status === "done" ? "x" : i.status === "doing" ? ">" : " "}] ${i.text}`,
        )
        .join("\n"),
      changes: [],
    };
  },
});
