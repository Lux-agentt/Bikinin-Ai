// Reads the full instructions of one skill (AGENTS.md Lampiran C).
// Skills live in the repo's skills/ directory and are read-only during a run:
// the agent reads them, never rewrites them. The skill name is a single
// directory name; path escapes are rejected before any file is read.
import { z } from "zod";
import { readSkill, REPO_SKILLS_DIR } from "../skills/loader.js";
import { defineTool, truncate } from "./types.js";

export const readSkillTool = defineTool({
  name: "read_skill",
  description:
    "Baca instruksi lengkap sebuah skill dari skills/<nama>/SKILL.md. Wajib dipanggil sebelum mengerjakan tugas yang cocok dengan deskripsi skill itu. Nama skill persis seperti di daftar skill (mis. website).",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Nama skill, mis. website" },
    },
    required: ["name"],
    additionalProperties: false,
  },
  readOnly: true,
  schema: z.object({
    name: z.string().min(1),
  }),
  label: (a) => `read_skill ${a.name}`,
  publicArgs: (a) => ({ name: a.name }),
  async run(a) {
    const text = await readSkill(REPO_SKILLS_DIR, a.name);
    const cut = truncate(text);
    return {
      ok: true,
      summary: `skill ${a.name} (${text.length} karakter${cut.truncated ? ", dipotong" : ""})`,
      output: cut.text,
      changes: [],
    };
  },
});
