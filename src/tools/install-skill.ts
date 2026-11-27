// Tool install_skill: pasang skill baru dari link GitHub ke SKILL.md atau
// dari isi SKILL.md yang ditempel. Menulis ke folder skills/ repo (di luar
// workspace), jadi confirm-gated seperti git push: pemilik menyetujui tiap
// pemasangan. Skill langsung tersedia di run berikutnya (hot reload Fase 8).
import { z } from "zod";
import { AgentError } from "../errors.js";
import { installSkill, InstallError } from "../skills/install.js";
import { defineTool } from "./types.js";

const installSkillSchema = z
  .object({
    url: z
      .string()
      .url("url harus link lengkap, mis. https://github.com/owner/repo/blob/main/skills/x/SKILL.md")
      .optional(),
    content: z.string().max(64 * 1024).optional(),
    name: z.string().optional(),
  })
  .refine((a) => (a.url ? 1 : 0) + (a.content ? 1 : 0) === 1, {
    message:
      "isi salah satu: url (link GitHub ke SKILL.md) atau content (isi SKILL.md), bukan dua-duanya",
  });

export const installSkillTool = defineTool({
  name: "install_skill",
  description:
    "Pasang skill baru dari link GitHub ke file SKILL.md atau dari isi SKILL.md yang ditempel. Skill langsung tersedia di run berikutnya (tanpa restart server). Pakai saat pemilik minta tambah skill baru — misalnya 'tambahin skill X dari link ini'. Frontmatter SKILL.md harus punya name (sama dengan nama folder) dan description.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "Link GitHub ke file SKILL.md (blob atau raw). Hanya github.com dan raw.githubusercontent.com yang diterima.",
      },
      content: {
        type: "string",
        description: "Isi lengkap SKILL.md yang ditempel (maks 64 KB).",
      },
      name: {
        type: "string",
        description:
          "Nama skill yang diharapkan — harus sama dengan frontmatter name. Boleh dikosongkan.",
      },
    },
    required: [],
    additionalProperties: false,
  },
  readOnly: false,
  schema: installSkillSchema,
  // Menulis ke repo di luar workspace: selalu minta persetujuan pemilik.
  gate: () => ({
    decision: "confirm",
    command: "install_skill",
    reason: "menulis skill baru ke folder skills/ repo — minta persetujuan pemilik tiap kali",
    risk: "medium",
  }),
  label: (a) => `install_skill ${a.url ?? "dari teks"}`,
  publicArgs: (a) => ({
    url: a.url,
    name: a.name,
    hasContent: Boolean(a.content),
  }),
  async run(a) {
    try {
      const s = await installSkill(a);
      return {
        ok: true,
        summary: `skill "${s.name}" terpasang`,
        output: `Skill "${s.name}" terpasang di skills/${s.name}/SKILL.md — ${s.description} (tersedia di run berikutnya, tanpa restart).`,
        changes: [
          {
            path: `skills/${s.name}/SKILL.md`,
            op: "created" as const,
            bytes: s.bytes,
          },
        ],
      };
    } catch (err) {
      if (err instanceof InstallError) {
        throw new AgentError("tool_failed", err.message);
      }
      throw err;
    }
  },
});
