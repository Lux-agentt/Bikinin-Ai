import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import type { Config } from "../src/config.js";
import type { ChatResult, LlmClient } from "../src/llm/client.js";
import { RunManager } from "../src/server/runs.js";
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
  it("lists the real website and remotion skills and nothing else is leaked", async () => {
    const skills = await listSkills(REPO_SKILLS_DIR);
    expect(skills).toEqual([
      {
        name: "remotion",
        description:
          "Gunakan saat pengguna ingin membuat video, animasi, atau motion graphic dengan Remotion.",
      },
      {
        name: "website",
        description:
          "Gunakan saat pengguna ingin membuat website, landing page, atau halaman web baru, atau memperbaiki tampilan dan struktur website yang sudah ada.",
      },
    ]);
    const prompt = await loadSystemPrompt(formatSkillList(skills));
    expect(prompt).toContain("- website: Gunakan saat pengguna ingin membuat");
    expect(prompt).toContain("- remotion: Gunakan saat pengguna ingin membuat video");
    expect(prompt).not.toContain("{{DAFTAR_SKILL}}");
    expect(prompt).not.toContain("(belum ada skill)");
    // Only name + description enter the prompt, never the full skill text.
    expect(prompt).not.toContain("Kesalahan umum");
  });
});

describe("hot reload skill (Fase 8)", () => {
  const testCfg: Config = {
    providers: [
      {
        name: "t",
        baseUrl: "https://x.test/v1",
        apiKey: "k",
        model: "test-model",
        inPerM: 1,
        outPerM: 2,
      },
    ],
    BIKININ_USD_IDR: 17000,
    BIKININ_MAX_STEPS: 10,
    BIKININ_MAX_COST_USD: 1,
    BIKININ_WORKSPACE: "./workspace",
    BIKININ_MAX_VIDEO_SECONDS: 30,
  };

  async function waitFinished(manager: RunManager, runId: string) {
    const t0 = Date.now();
    while (!manager.get(runId)?.finished) {
      if (Date.now() - t0 > 5000)
        throw new Error("timeout menunggu run selesai");
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it("skill baru muncul di run berikutnya tanpa restart server", async () => {
    const skillsDir = await mkdtemp(join(tmpdir(), "bikinin-skills-"));
    await makeSkill(skillsDir, "website", GOOD);
    const workspace = await realpath(await tempWorkspace());

    // Stub LLM: finishes immediately, but records the system prompt it got.
    const seenPrompts: string[] = [];
    const llm: LlmClient = {
      async chat(p) {
        const first = p.messages[0] as { content?: unknown } | undefined;
        seenPrompts.push(
          typeof first?.content === "string" ? first.content : "",
        );
        return {
          text: "selesai",
          toolCalls: [],
          usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0 },
        } satisfies ChatResult;
      },
    };

    const buildSystemPrompt = async () =>
      loadSystemPrompt(formatSkillList(await listSkills(skillsDir)));
    const manager = new RunManager(testCfg, {
      workspace,
      systemPrompt: await buildSystemPrompt(),
      buildSystemPrompt,
      llm,
    });

    const run1 = manager.start({
      message: "tes satu",
      attachment_ids: [],
      effort: "sedang",
    });
    await waitFinished(manager, run1.run_id);
    expect(seenPrompts).toHaveLength(1);
    expect(seenPrompts[0]).toContain(
      "- website: Gunakan saat membuat website.",
    );
    expect(seenPrompts[0]).not.toContain("baru-skill");

    // Folder skill baru ditambah SELAMA "server" jalan, tanpa restart.
    await makeSkill(
      skillsDir,
      "baru-skill",
      `---\nname: baru-skill\ndescription: Skill yang baru ditambah.\n---\n\n# Baru\n`,
    );

    const run2 = manager.start({
      message: "tes dua",
      attachment_ids: [],
      effort: "sedang",
    });
    await waitFinished(manager, run2.run_id);
    expect(seenPrompts).toHaveLength(2);
    expect(seenPrompts[1]).toContain("- baru-skill: Skill yang baru ditambah.");
    // Skill lama tetap ada; read_skill juga langsung bisa membacanya
    // (readSkill me-list ulang tiap panggilan).
    expect(seenPrompts[1]).toContain(
      "- website: Gunakan saat membuat website.",
    );
    expect(await readSkill(skillsDir, "baru-skill")).toContain("# Baru");
  });

  it("skill rusak yang ditambah belakangan di-skip, run tetap jalan", async () => {
    const skillsDir = await mkdtemp(join(tmpdir(), "bikinin-skills-"));
    await makeSkill(skillsDir, "website", GOOD);
    const workspace = await realpath(await tempWorkspace());
    const seenPrompts: string[] = [];
    const llm: LlmClient = {
      async chat(p) {
        const first = p.messages[0] as { content?: unknown } | undefined;
        seenPrompts.push(
          typeof first?.content === "string" ? first.content : "",
        );
        return {
          text: "selesai",
          toolCalls: [],
          usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0 },
        } satisfies ChatResult;
      },
    };
    const buildSystemPrompt = async () =>
      loadSystemPrompt(formatSkillList(await listSkills(skillsDir)));
    const manager = new RunManager(testCfg, {
      workspace,
      systemPrompt: await buildSystemPrompt(),
      buildSystemPrompt,
      llm,
    });

    await makeSkill(skillsDir, "rusak", "# tanpa frontmatter\n");
    const run = manager.start({
      message: "tes",
      attachment_ids: [],
      effort: "sedang",
    });
    await waitFinished(manager, run.run_id);
    expect(seenPrompts).toHaveLength(1);
    expect(seenPrompts[0]).toContain("- website:");
    expect(seenPrompts[0]).not.toContain("rusak");
    expect(manager.get(run.run_id)?.events.at(-1)?.type).toBe("run_finished");
  });
});
