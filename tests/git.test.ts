import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitTool } from "../src/tools/git.js";
import { tempWorkspace } from "./helpers.js";

function git(
  cwd: string,
  args: string[],
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      resolve({
        code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
        output: stdout + stderr,
      });
    });
  });
}

async function initRepo(): Promise<string> {
  const ws = await tempWorkspace();
  await git(ws, ["init", "-b", "main"]);
  await git(ws, ["config", "user.name", "Tes"]);
  await git(ws, ["config", "user.email", "tes@example.com"]);
  await writeFile(join(ws, "a.txt"), "halo\n");
  await git(ws, ["add", "-A"]);
  await git(ws, ["commit", "-m", "commit awal"]);
  return ws;
}

async function runGit(raw: unknown, ws: string) {
  const parsed = gitTool.parse(raw);
  if (!parsed.ok) throw new Error(`argumen tidak valid: ${parsed.error}`);
  return parsed.execute({ workspace: ws });
}

describe("git status / diff / log", () => {
  it("status bersih setelah commit", async () => {
    const ws = await initRepo();
    const r = await runGit({ op: "status" }, ws);
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/Bersih/);
  });

  it("status menampilkan file yang diubah", async () => {
    const ws = await initRepo();
    await writeFile(join(ws, "a.txt"), "halo\ndunia\n");
    const r = await runGit({ op: "status" }, ws);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("a.txt");
    expect(r.summary).toContain("1 file berubah");
  });

  it("diff menampilkan isi perubahan file terlacak", async () => {
    const ws = await initRepo();
    await writeFile(join(ws, "a.txt"), "halo\ndunia\n");
    const r = await runGit({ op: "diff" }, ws);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("+dunia");
  });

  it("diff kosong bila tidak ada perubahan", async () => {
    const ws = await initRepo();
    const r = await runGit({ op: "diff" }, ws);
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/Tidak ada perubahan/);
  });

  it("log menampilkan commit yang ada", async () => {
    const ws = await initRepo();
    const r = await runGit({ op: "log" }, ws);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("commit awal");
  });
});

describe("git commit", () => {
  it("commit perubahan dan tercatat di log", async () => {
    const ws = await initRepo();
    await writeFile(join(ws, "a.txt"), "halo\ndunia\n");
    const r = await runGit({ op: "commit", message: "tambah dunia" }, ws);
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/^commit [0-9a-f]+: tambah dunia$/);
    expect(r.changes).toEqual([{ path: "a.txt", op: "modified", bytes: 0 }]);
    const log = await runGit({ op: "log" }, ws);
    expect(log.output).toContain("tambah dunia");
  });

  it("commit tanpa perubahan mengembalikan ok dengan pesan jelas", async () => {
    const ws = await initRepo();
    const r = await runGit({ op: "commit", message: "tidak ada apa-apa" }, ws);
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/tidak ada perubahan untuk di-commit/);
  });

  it("menolak commit tanpa message", () => {
    expect(gitTool.parse({ op: "commit" }).ok).toBe(false);
    expect(gitTool.parse({ op: "commit", message: "   " }).ok).toBe(false);
  });

  it("menolak message lebih dari 200 karakter", () => {
    expect(gitTool.parse({ op: "commit", message: "x".repeat(201) }).ok).toBe(
      false,
    );
    expect(gitTool.parse({ op: "commit", message: "x".repeat(200) }).ok).toBe(
      true,
    );
  });

  it("menolak message multi-baris / karakter kontrol", () => {
    expect(
      gitTool.parse({ op: "commit", message: "baris satu\nbaris dua" }).ok,
    ).toBe(false);
    expect(gitTool.parse({ op: "commit", message: "a\tb" }).ok).toBe(false);
  });
});

describe("git branch", () => {
  it("membuat branch baru lalu muncul di daftar", async () => {
    const ws = await initRepo();
    const created = await runGit({ op: "branch", name: "fitur-x" }, ws);
    expect(created.ok).toBe(true);
    expect(created.summary).toContain("fitur-x");
    const listed = await runGit({ op: "branch" }, ws);
    expect(listed.output).toContain("fitur-x");
    expect(listed.output).toContain("main");
  });

  it("menolak nama branch tidak valid", () => {
    for (const name of ["a..b", "-x", "a//b", "a/", "a.lock", "a b", ""]) {
      expect(gitTool.parse({ op: "branch", name }).ok).toBe(false);
    }
  });
});

describe("git guard", () => {
  it("menolak op di luar enum (push/fetch/reset tidak ada)", () => {
    for (const op of [
      "push",
      "fetch",
      "pull",
      "clone",
      "reset",
      "clean",
      "checkout",
    ]) {
      expect(gitTool.parse({ op }).ok).toBe(false);
    }
  });

  it("menolak workspace yang bukan repo git", async () => {
    const ws = await tempWorkspace();
    await expect(runGit({ op: "status" }, ws)).rejects.toThrow(
      "bukan repositori git",
    );
  });

  it("menolak log di repo tanpa commit dengan pesan jelas", async () => {
    const ws = await tempWorkspace();
    await git(ws, ["init", "-b", "main"]);
    const r = await runGit({ op: "log" }, ws);
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/Belum ada commit/);
  });
});
