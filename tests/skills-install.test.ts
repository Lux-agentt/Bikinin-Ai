// Unit tests for installSkill (src/skills/install.ts). The installer
// writes into a temp dir, never the real repo skills/ folder.
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installSkill,
  InstallError,
  toRawUrl,
} from "../src/skills/install.js";

const GOOD =
  '---\nname: contoh-skill\ndescription: Skill contoh untuk tes.\n---\n\n# Contoh\n\nIsi skill.\n';

describe("toRawUrl", () => {
  it("converts a github.com blob link to raw", () => {
    expect(
      toRawUrl(
        "https://github.com/owner/repo/blob/main/skills/contoh-skill/SKILL.md",
      ),
    ).toBe(
      "https://raw.githubusercontent.com/owner/repo/main/skills/contoh-skill/SKILL.md",
    );
  });

  it("passes a raw link through unchanged", () => {
    const raw =
      "https://raw.githubusercontent.com/owner/repo/main/SKILL.md";
    expect(toRawUrl(raw)).toBe(raw);
  });

  it("rejects non-GitHub hosts", () => {
    expect(() => toRawUrl("https://example.com/SKILL.md")).toThrow(
      InstallError,
    );
  });

  it("rejects a repo root link (not a file)", () => {
    expect(() => toRawUrl("https://github.com/owner/repo")).toThrow(
      InstallError,
    );
  });
});

describe("installSkill", () => {
  let dir: string;
  const fetchMock = vi.fn();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bikinin-skill-"));
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function expectInstallError(p: Promise<unknown>, status: number) {
    await expect(p).rejects.toMatchObject({
      name: "InstallError",
      status,
    });
  }

  it("installs pasted content into skills/<name>/SKILL.md", async () => {
    const s = await installSkill({ content: GOOD }, dir);
    expect(s).toEqual({
      name: "contoh-skill",
      description: "Skill contoh untuk tes.",
      bytes: Buffer.byteLength(GOOD, "utf8"),
      path: "skills/contoh-skill/SKILL.md",
    });
    expect(
      await readFile(join(dir, "contoh-skill", "SKILL.md"), "utf8"),
    ).toBe(GOOD);
  });

  it("installs a skill with a known group category into its group folder", async () => {
    const grouped =
      '---\nname: contoh-video\ndescription: Skill video contoh.\ncategory: video\n---\n\n# Contoh\n';
    const s = await installSkill({ content: grouped }, dir);
    expect(s.path).toBe("skills/video/contoh-video/SKILL.md");
    expect(
      await readFile(join(dir, "video", "contoh-video", "SKILL.md"), "utf8"),
    ).toBe(grouped);
  });

  it("installs from a GitHub link (fetches the raw URL)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => GOOD,
    });
    const s = await installSkill(
      {
        url: "https://github.com/owner/repo/blob/main/skills/contoh-skill/SKILL.md",
      },
      dir,
    );
    expect(s.name).toBe("contoh-skill");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/owner/repo/main/skills/contoh-skill/SKILL.md",
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(
      await readFile(join(dir, "contoh-skill", "SKILL.md"), "utf8"),
    ).toBe(GOOD);
  });

  it("rejects content without frontmatter name + description", async () => {
    await expectInstallError(
      installSkill({ content: "# Tanpa frontmatter\n" }, dir),
      400,
    );
  });

  it("rejects a frontmatter name that is not a valid folder name", async () => {
    await expectInstallError(
      installSkill(
        {
          content:
            "---\nname: Nama Buruk!\ndescription: x\n---\n\nisi\n",
        },
        dir,
      ),
      400,
    );
  });

  it("rejects when the requested name differs from the frontmatter", async () => {
    await expectInstallError(
      installSkill({ content: GOOD, name: "lain" }, dir),
      400,
    );
  });

  it("refuses to overwrite an existing skill", async () => {
    await installSkill({ content: GOOD }, dir);
    await expectInstallError(installSkill({ content: GOOD }, dir), 409);
  });

  it("maps a 404 fetch to InstallError 404", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "Not Found",
    });
    await expectInstallError(
      installSkill(
        { url: "https://github.com/o/r/blob/main/SKILL.md" },
        dir,
      ),
      404,
    );
  });

  it("rejects an oversize skill file", async () => {
    await expectInstallError(
      installSkill({ content: "x".repeat(65 * 1024) }, dir),
      413,
    );
    // A missing skill dir stays missing: nothing was written.
    await expect(access(join(dir, "contoh-skill"))).rejects.toThrow();
  });
});
