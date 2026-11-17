import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatSkillList,
  listSkills,
  parseFrontmatter,
  readSkill,
  REPO_SKILLS_DIR,
} from "../src/skills/loader.js";
import { loadSystemPrompt } from "../src/prompt.js";
import { runTool, tempWorkspace } from "./helpers.js";

async function makeSkill(
  dir: string,
  folder: string,
  content: string,
): Promise<void> {
  await mkdir(join(dir, folder), { recursive: true });
  await writeFile(join(dir, folder, "SKILL.md"), content);
}

const GOOD = `---
name: website
description: Gunakan saat membuat website.
---

# Website

Isi skill.
`;

describe("parseFrontmatter", () => {
  it("reads name and description", () => {
    expect(parseFrontmatter(GOOD)).toEqual({
      name: "website",
      description: "Gunakan saat membuat website.",
    });
  });

  it("returns {} without a frontmatter block", () => {
    expect(parseFrontmatter("# tanpa frontmatter\n")).toEqual({});
  });

  it("ignores other keys and a stray name: inside the description", () => {
    const text = `---
name: website
description: Buat website; kalau ragu, name: bukan kunci di sini.
version: 3
---

# x
`;
    expect(parseFrontmatter(text)).toEqual({
      name: "website",
      description:
        "Buat website; kalau ragu, name: bukan kunci di sini.",
    });
  });

  it("strips surrounding quotes", () => {
    expect(
      parseFrontmatter(`---\nname: "website"\ndescription: 'Buat web.'\n---\n`),
    ).toEqual({ name: "website", description: "Buat web." });
  });
});

describe("listSkills", () => {
  it("returns [] for a missing folder", async () => {
    expect(await listSkills(join(await tempWorkspace(), "tidak-ada"))).toEqual(
      [],
    );
  });

  it("lists valid skills sorted, skips broken ones", async () => {
    const dir = await tempWorkspace();
    await makeSkill(dir, "website", GOOD);
    await makeSkill(
      dir,
      "zeta",
      `---\nname: zeta\ndescription: Skill Z.\n---\n\n# Z\n`,
    );
    await makeSkill(dir, "rusak", "# tanpa frontmatter\n");
    await makeSkill(
      dir,
      "salah-nama",
      `---\nname: lain\ndescription: Nama tidak sama dengan folder.\n---\n\n# x\n`,
    );
    await mkdir(join(dir, "kosong"), { recursive: true });
    expect(await listSkills(dir)).toEqual([
      { name: "website", description: "Gunakan saat membuat website." },
      { name: "zeta", description: "Skill Z." },
    ]);
  });
});

describe("formatSkillList", () => {
  it("is the placeholder text when empty", () => {
    expect(formatSkillList([])).toBe("(belum ada skill)");
  });

  it("lists name and description only", () => {
    expect(
      formatSkillList([
        { name: "website", description: "Gunakan saat membuat website." },
      ]),
    ).toBe("- website: Gunakan saat membuat website.");
  });
});

describe("readSkill", () => {
  it("reads a skill by name", async () => {
    const dir = await tempWorkspace();
    await makeSkill(dir, "website", GOOD);
    expect(await readSkill(dir, "website")).toBe(GOOD);
  });

  it("rejects traversal, absolute paths, and unknown names", async () => {
    const dir = await tempWorkspace();
    await makeSkill(dir, "website", GOOD);
    for (const bad of [
      "../rahasia",
      "..",
      "/etc/passwd",
      "web site",
      "WEBSITE",
      "tidak-ada",
      "website/../../rahasia",
    ]) {
      await expect(readSkill(dir, bad)).rejects.toThrow();
    }
  });

  it("rejects a skill whose frontmatter name does not match its folder", async () => {
    const dir = await tempWorkspace();
    await makeSkill(
      dir,
      "salah-nama",
      `---\nname: lain\ndescription: x.\n---\n\n# x\n`,
    );
    await expect(readSkill(dir, "lain")).rejects.toThrow();
    await expect(readSkill(dir, "salah-nama")).rejects.toThrow();
  });
});

describe("read_skill tool", () => {
  it("reads the website skill from the repo skills dir", async () => {
    const ws = await tempWorkspace();
    const r = await runTool("read_skill", { name: "website" }, ws);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("# Website");
    expect(r.output).toContain("Responsif");
    expect(r.changes).toEqual([]);
  });

  it("fails cleanly on escape attempts and unknown skills", async () => {
    const ws = await tempWorkspace();
    await expect(
      runTool("read_skill", { name: "../../etc/passwd" }, ws),
    ).rejects.toThrow();
    await expect(
      runTool("read_skill", { name: "tidak-ada" }, ws),
    ).rejects.toThrow("tidak ditemukan");
  });
});

describe("system prompt wiring", () => {
  it("lists the real website skill and nothing else is leaked", async () => {
    const skills = await listSkills(REPO_SKILLS_DIR);
    expect(skills).toEqual([
      {
        name: "website",
        description:
          "Gunakan saat pengguna ingin membuat website, landing page, atau halaman web baru, atau memperbaiki tampilan dan struktur website yang sudah ada.",
      },
    ]);
    const prompt = await loadSystemPrompt(formatSkillList(skills));
    expect(prompt).toContain("- website: Gunakan saat pengguna ingin membuat");
    expect(prompt).not.toContain("{{DAFTAR_SKILL}}");
    expect(prompt).not.toContain("(belum ada skill)");
    // Only name + description enter the prompt, never the full skill text.
    expect(prompt).not.toContain("Kesalahan umum");
  });
});
