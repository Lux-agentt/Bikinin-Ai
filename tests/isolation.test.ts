import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentError } from "../src/errors.js";
import { assertWorkspaceIsolated } from "../src/safety/paths.js";
import { execSandboxed, sandboxStageDir } from "../src/tools/run-command.js";

describe("assertWorkspaceIsolated", () => {
  it("accepts a folder with no project markers above it", async () => {
    const base = await mkdtemp(join(tmpdir(), "bikinin-iso-"));
    const ws = join(base, "ws");
    await mkdir(ws);
    await expect(assertWorkspaceIsolated(ws)).resolves.toBeUndefined();
  });

  it("rejects a workspace inside a folder that has package.json", async () => {
    const base = await mkdtemp(join(tmpdir(), "bikinin-iso-"));
    await writeFile(join(base, "package.json"), "{}");
    const ws = join(base, "workspace");
    await mkdir(ws);
    await expect(assertWorkspaceIsolated(ws)).rejects.toThrow("package.json");
  });

  it("accepts a workspace that holds its own package.json (agent-built project)", async () => {
    const base = await mkdtemp(join(tmpdir(), "bikinin-iso-"));
    const ws = join(base, "ws");
    await mkdir(ws);
    await writeFile(join(ws, "package.json"), "{}");
    await expect(assertWorkspaceIsolated(ws)).resolves.toBeUndefined();
  });

  it("accepts a workspace that is itself a git repository (Fase 6: the git tool needs one)", async () => {
    const base = await mkdtemp(join(tmpdir(), "bikinin-iso-"));
    const ws = join(base, "ws");
    await mkdir(join(ws, ".git"), { recursive: true });
    await expect(assertWorkspaceIsolated(ws)).resolves.toBeUndefined();
  });

  it("rejects a workspace inside a git repository", async () => {
    const base = await mkdtemp(join(tmpdir(), "bikinin-iso-"));
    await mkdir(join(base, ".git"));
    const ws = join(base, "workspace");
    await mkdir(ws);
    await expect(assertWorkspaceIsolated(ws)).rejects.toThrow(".git");
  });
});

describe("sandboxStageDir", () => {
  it("memakai /mnt untuk workspace biasa", () => {
    expect(sandboxStageDir("/home/hatch/workspace/ws")).toBe(
      "/mnt/.bikinin-ws",
    );
    expect(sandboxStageDir("/tmp/bikinin-test-abc")).toBe("/mnt/.bikinin-ws");
  });

  it("memakai /var bila workspace ada di bawah /mnt", () => {
    expect(sandboxStageDir("/mnt")).toBe("/var/.bikinin-ws");
    expect(sandboxStageDir("/mnt/foo/ws")).toBe("/var/.bikinin-ws");
  });
});

describe("execSandboxed menolak workspace yang tidak valid", () => {
  it("menolak root filesystem (/) sebagai workspace", async () => {
    try {
      await execSandboxed("true", "/");
      throw new Error("seharusnya menolak /");
    } catch (e) {
      expect(e).toBeInstanceOf(AgentError);
      expect((e as AgentError).code).toBe("tool_failed");
    }
  });

  it("menolak workspace yang tidak ada", async () => {
    try {
      await execSandboxed("true", "/tmp/bikinin-tidak-ada-xyz");
      throw new Error("seharusnya menolak workspace yang tidak ada");
    } catch (e) {
      expect(e).toBeInstanceOf(AgentError);
      expect((e as AgentError).code).toBe("tool_failed");
    }
  });
});
