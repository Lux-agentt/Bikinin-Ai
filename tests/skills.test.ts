import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CATEGORY_ORDER,
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

  it("reads category when present, omits it when absent", () => {
    expect(
      parseFrontmatter(
        `---\nname: website\ncategory: website\ndescription: Buat web.\n---\n`,
      ),
    ).toEqual({
      name: "website",
      description: "Buat web.",
      category: "website",
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
      {
        name: "website",
        description: "Gunakan saat membuat website.",
        category: "lainnya",
      },
      { name: "zeta", description: "Skill Z.", category: "lainnya" },
    ]);
  });

  it("lists the bounty skills shipped in the repo", async () => {
    const names = (await listSkills(REPO_SKILLS_DIR)).map((s) => s.name);
    for (const expected of [
      "bug-bounty-writeups",
      "web3-ai-tools",
      "web3-bug-classes",
      "web3-case-study-role-misconfig",
      "web3-grep-arsenal",
      "web3-hunt-foundation",
      "web3-hunt-zksync-era",
      "web3-methodology-research",
      "web3-poc-foundry",
      "web3-solidity-audit-mcp",
      "web3-start-here",
      "web3-triage-report",
    ]) {
      expect(names).toContain(expected);
    }
  });
});

describe("formatSkillList", () => {
  it("is the placeholder text when empty", () => {
    expect(formatSkillList([])).toBe("(belum ada skill)");
  });

  it("groups skills by category, one line per skill", () => {
    expect(
      formatSkillList([
        {
          name: "website",
          description: "Gunakan saat membuat website.",
          category: "website",
        },
        {
          name: "remotion",
          description: "Buat video.",
          category: "video",
        },
        {
          name: "zeta",
          description: "Skill Z.",
          category: "lainnya",
        },
      ]),
    ).toBe(
      "### video\n- remotion: Buat video.\n" +
        "### website\n- website: Gunakan saat membuat website.\n" +
        "### lainnya\n- zeta: Skill Z.",
    );
  });

  it("an invalid category value falls back to lainnya", () => {
    // Pernah kejadian: 3 skill motion membawa `category: frontend` dari
    // sumber aslinya — bukan bagian dari 5 kelompok, jadi dikelompokkan
    // ke lainnya daripada membuat grup ke-6.
    expect(
      formatSkillList([
        {
          name: "motion-foundations",
          description: "Dasar motion.",
          category: "FRONTEND!!",
        },
      ]),
    ).toBe("### lainnya\n- motion-foundations: Dasar motion.");
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
    const names = skills.map((s) => s.name);
    // 25 skill bawaan tetap ada, plus 327 skill ECC (brand-voice ECC di-skip:
    // yang dipakai tetap brand-voice Rizqi).
    for (const expected of [
      "brand-voice",
      "bug-bounty-reporting",
      "bug-bounty-scope",
      "bug-bounty-writeups",
      "codebase-maintenance",
      "content-calendar",
      "content-repurpose",
      "instagram-content",
      "remotion",
      "remotion-short-form",
      "seo-content",
      "web-research",
      "web3-ai-tools",
      "web3-bug-classes",
      "web3-case-study-role-misconfig",
      "web3-grep-arsenal",
      "web3-hunt-foundation",
      "web3-hunt-zksync-era",
      "web3-methodology-research",
      "web3-poc-foundry",
      "web3-solidity-audit-mcp",
      "web3-start-here",
      "web3-triage-report",
      "website",
      "website-qa",
    ]) {
      expect(names).toContain(expected);
    }
    expect(skills).toHaveLength(201);
    for (const ecc of ["accessibility", "api-design", "docker-patterns"]) {
      expect(names).toContain(ecc);
    }
    expect(names).toContain("free-for-dev");
    expect(skills.find((s) => s.name === "website")).toEqual({
      name: "website",
      description:
        "Gunakan saat pengguna ingin membuat website, landing page, atau halaman web baru, atau memperbaiki tampilan dan struktur website yang sudah ada.",
      category: "website",
    });
    expect(skills.find((s) => s.name === "remotion")).toEqual({
      name: "remotion",
      description:
        "Gunakan saat pengguna ingin membuat video, animasi, atau motion graphic dengan Remotion.",
      category: "video",
    });
    const prompt = await loadSystemPrompt(formatSkillList(skills));
    expect(prompt).toContain("- website: Gunakan saat pengguna ingin membuat");
    expect(prompt).toContain("- remotion: Gunakan saat pengguna ingin membuat video");
    expect(prompt).toContain("- bug-bounty-writeups: Learn bug bounty methodology");
    expect(prompt).not.toContain("{{DAFTAR_SKILL}}");
    expect(prompt).not.toContain("(belum ada skill)");
    // Only name + description enter the prompt, never the full skill text.
    expect(prompt).not.toContain("Kesalahan umum");
    expect(prompt).not.toContain("Accounting Desync");
  });
});

describe("kategori skill (2026-11-28: 5 kelompok; 152 skill dihapus atas persetujuan user)", () => {
  const EXPECTED_COUNTS: Record<string, number> = {
    video: 16,
    coding: 126,
    website: 18,
    writing: 18,
    bounty: 23,
  };

  it("setiap skill punya kategori dari 5 kelompok yang dikenal, 201 skill tersisa", async () => {
    const skills = await listSkills(REPO_SKILLS_DIR);
    expect(skills).toHaveLength(201);
    const counts: Record<string, number> = {};
    for (const s of skills) {
      expect(CATEGORY_ORDER).toContain(s.category);
      counts[s.category] = (counts[s.category] ?? 0) + 1;
    }
    expect(counts).toEqual(EXPECTED_COUNTS);
  });

  it("prompt mengelompokkan skill per kelompok (video dulu, bounty terakhir)", async () => {
    const skills = await listSkills(REPO_SKILLS_DIR);
    const list = formatSkillList(skills);
    const iVid = list.indexOf("### video\n");
    const iCod = list.indexOf("### coding\n");
    const iWeb = list.indexOf("### website\n");
    const iWri = list.indexOf("### writing\n");
    const iBou = list.indexOf("### bounty\n");
    expect(iVid).toBeGreaterThanOrEqual(0);
    expect(iCod).toBeGreaterThan(iVid);
    expect(iWeb).toBeGreaterThan(iCod);
    expect(iWri).toBeGreaterThan(iWeb);
    expect(iBou).toBeGreaterThan(iWri);
    // Skill pertama tiap kelompok (urut alfabet di dalam kelompok).
    expect(list).toContain("### video\n- blender-motion-state-inspection:");
    expect(list).toContain("### coding\n- android-clean-architecture:");
    expect(list).toContain("### website\n- accessibility:");
    expect(list).toContain("### writing\n- article-writing:");
    expect(list).toContain("### bounty\n- bug-bounty-reporting:");
    // Judul kelompok cuma 5, tidak ada grup liar dari nilai lama.
    expect(list.match(/^### .+$/gm)).toHaveLength(5);
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

describe("website skill: mandatory styling rules (regression lock)", () => {
  it("skill website memuat aturan CSS wajib + cek kualitas visual", async () => {
    const text = await readSkill(REPO_SKILLS_DIR, "website");
    for (const marker of [
      "CSS wajib",
      "CSS minimal wajib",
      "Cek kualitas visual",
      "nav-list",
      "font-family",
    ]) {
      expect(text).toContain(marker);
    }
  });

  it("system prompt memuat standar CSS nyata untuk website", async () => {
    const prompt = await loadSystemPrompt(
      formatSkillList(await listSkills(REPO_SKILLS_DIR)),
    );
    expect(prompt).toContain("Setiap halaman WAJIB punya CSS nyata");
    expect(prompt).toContain("Cek kualitas visual");
  });
});
