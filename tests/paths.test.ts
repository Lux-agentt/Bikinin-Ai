import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInWorkspace } from "../src/safety/paths.js";

async function setup() {
  const base = await mkdtemp(join(tmpdir(), "bikinin-paths-"));
  const ws = join(base, "ws");
  const outside = join(base, "outside");
  await mkdir(ws);
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "rahasia");
  return { ws, outside };
}

describe("resolveInWorkspace", () => {
  it("accepts a path inside the workspace, including one not yet created", async () => {
    const { ws } = await setup();
    const r = await resolveInWorkspace(ws, "sub/baru/index.html");
    expect(r.rel).toBe("sub/baru/index.html");
  });

  it("blocks ../ traversal", async () => {
    const { ws } = await setup();
    await expect(
      resolveInWorkspace(ws, "../outside/secret.txt"),
    ).rejects.toMatchObject({
      code: "path_blocked",
    });
  });

  it("blocks absolute paths", async () => {
    const { ws, outside } = await setup();
    await expect(
      resolveInWorkspace(ws, join(outside, "secret.txt")),
    ).rejects.toMatchObject({
      code: "path_blocked",
    });
  });

  it("blocks a symlinked directory that points outside", async () => {
    const { ws, outside } = await setup();
    await symlink(outside, join(ws, "link"));
    await expect(
      resolveInWorkspace(ws, "link/secret.txt"),
    ).rejects.toMatchObject({
      code: "path_blocked",
    });
  });

  it("blocks a write to a file that is a symlink to outside", async () => {
    const { ws, outside } = await setup();
    await symlink(join(outside, "secret.txt"), join(ws, "alias.txt"));
    await expect(resolveInWorkspace(ws, "alias.txt")).rejects.toMatchObject({
      code: "path_blocked",
    });
  });

  it("blocks a symlink nested in a subdirectory that points outside", async () => {
    const { ws, outside } = await setup();
    await mkdir(join(ws, "sub"));
    await symlink(outside, join(ws, "sub", "link"));
    await expect(
      resolveInWorkspace(ws, "sub/link/secret.txt"),
    ).rejects.toMatchObject({ code: "path_blocked" });
  });

  it("blocks .. that escapes through a symlinked parent", async () => {
    const { ws } = await setup();
    await expect(
      resolveInWorkspace(ws, "sub/../../outside/secret.txt"),
    ).rejects.toMatchObject({ code: "path_blocked" });
  });

  it("allows .. that stays inside the workspace", async () => {
    const { ws } = await setup();
    const r = await resolveInWorkspace(ws, "sub/../file.txt");
    expect(r.rel).toBe("file.txt");
  });

  it("rejects paths with a NUL byte", async () => {
    const { ws } = await setup();
    await expect(
      resolveInWorkspace(ws, "a\0b.txt"),
    ).rejects.toMatchObject({ code: "path_blocked" });
  });

  it.each([".env", ".env.local", "sub/.env", "key.pem", "id_rsa", "credentials.json", "notes-secret.txt"])(
    "blocks secret file %s",
    async (rel) => {
      const { ws } = await setup();
      await expect(resolveInWorkspace(ws, rel)).rejects.toMatchObject({
        code: "path_blocked",
      });
    },
  );

  it.each([".env.example", ".env.sample", "notes.txt", "src/index.ts"])(
    "allows non-secret file %s",
    async (rel) => {
      const { ws } = await setup();
      const r = await resolveInWorkspace(ws, rel);
      expect(r.rel).toBe(rel);
    },
  );

  it("blocks a symlink inside the workspace that points to a secret file", async () => {
    const { ws } = await setup();
    await writeFile(join(ws, ".env"), "KUNCI=PALSU");
    await symlink(join(ws, ".env"), join(ws, "alias.txt"));
    await expect(resolveInWorkspace(ws, "alias.txt")).rejects.toMatchObject({
      code: "path_blocked",
    });
  });
});
