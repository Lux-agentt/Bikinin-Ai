// Checkpoint tests (Fase 5): copy mode, git mode (secrets never
// snapshotted), prune cap, restore errors.
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
} from "../src/server/checkpoints.js";
import { tempWorkspace } from "./helpers.js";

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.toString().trim());
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("checkpoints (copy mode)", () => {
  it("snapshot lalu restore mengembalikan isi, menghapus file baru, dan .env/.gitignore tidak tersentuh", async () => {
    const ws = await tempWorkspace();
    await writeFile(join(ws, "index.html"), "v1");
    await writeFile(join(ws, "app.js"), "console.log(1)");
    await mkdir(join(ws, "sub"));
    await writeFile(join(ws, "sub", "style.css"), "body{}");
    await writeFile(join(ws, ".env"), "API_KEY=rahasia-penting");
    await writeFile(join(ws, ".gitignore"), "node_modules\n");
    const cp = await createCheckpoint(ws, "s_test", "run_test");
    expect(cp.method).toBe("copy");
    expect(cp.files).toContain("index.html");
    expect(cp.files).not.toContain(".env");

    await writeFile(join(ws, "index.html"), "v2-rusak");
    await writeFile(join(ws, "app.js"), "rusak");
    const { rm } = await import("node:fs/promises");
    await rm(join(ws, "sub", "style.css"));
    await writeFile(join(ws, "extra.txt"), "baru");
    await writeFile(join(ws, ".env"), "API_KEY=diubah-pengguna");

    const out = await restoreCheckpoint(ws, cp.id);
    expect(out.files_restored).toBe(cp.files.length);
    expect(await readFile(join(ws, "index.html"), "utf8")).toBe("v1");
    expect(await readFile(join(ws, "app.js"), "utf8")).toBe("console.log(1)");
    expect(await readFile(join(ws, "sub", "style.css"), "utf8")).toBe("body{}");
    await expect(readFile(join(ws, "extra.txt"), "utf8")).rejects.toThrow();
    // .env bukan bagian snapshot: tidak dipulihkan, tidak dihapus.
    expect(await readFile(join(ws, ".env"), "utf8")).toBe(
      "API_KEY=diubah-pengguna",
    );
    expect(await readFile(join(ws, ".gitignore"), "utf8")).toBe(
      "node_modules\n",
    );
  });

  it("list mengurutkan terbaru dulu dan prune membatasi 10", async () => {
    const ws = await tempWorkspace();
    await writeFile(join(ws, "a.txt"), "x");
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      ids.push((await createCheckpoint(ws, "s_test", "run_test")).id);
      await sleep(2);
    }
    const list = await listCheckpoints(ws);
    expect(list).toHaveLength(10);
    expect(new Set(list.map((c) => c.id)).size).toBe(10);
    expect(list[0].created_at >= list[9].created_at).toBe(true);
    // Yang paling lama dibuat sudah di-prune.
    expect(list.map((c) => c.id)).not.toContain(ids[0]);
    expect(list.map((c) => c.id)).toContain(ids[11]);
  });

  it("restore id yang tidak dikenal / format salah melempar error", async () => {
    const ws = await tempWorkspace();
    await expect(restoreCheckpoint(ws, "cp_00000000")).rejects.toThrow(
      /tidak ditemukan/,
    );
    await expect(restoreCheckpoint(ws, "../nakal")).rejects.toThrow(
      /tidak valid/,
    );
  });
});

describe("checkpoints (git mode)", () => {
  it("snapshot git menangkap seluruh tree; .env dan *.pem tidak masuk objek", async () => {
    const ws = await tempWorkspace();
    await git(ws, ["init", "-q"]);
    await writeFile(join(ws, "index.html"), "v1");
    await mkdir(join(ws, "sub"));
    await writeFile(join(ws, "sub", "key.pem"), "PRIVATE KEY PALSU");
    await writeFile(join(ws, ".env"), "API_KEY=rahasia-penting");
    await writeFile(join(ws, "notes.txt"), "catatan");
    const cp = await createCheckpoint(ws, "s_test", "run_test");
    expect(cp.method).toBe("git");
    expect(cp.git_commit).toMatch(/^[a-f0-9]{40}$/);
    const tree = await git(ws, [
      "ls-tree",
      "-r",
      "--name-only",
      cp.git_commit!,
    ]);
    expect(tree.split("\n")).toContain("index.html");
    expect(tree.split("\n")).toContain("notes.txt");
    expect(tree).not.toContain(".env");
    expect(tree).not.toContain("key.pem");

    await writeFile(join(ws, "index.html"), "v2-rusak");
    await writeFile(join(ws, "baru.txt"), "baru");
    const { rm } = await import("node:fs/promises");
    await rm(join(ws, "notes.txt"));
    const out = await restoreCheckpoint(ws, cp.id);
    expect(out.method).toBe("git");
    expect(await readFile(join(ws, "index.html"), "utf8")).toBe("v1");
    expect(await readFile(join(ws, "notes.txt"), "utf8")).toBe("catatan");
    await expect(readFile(join(ws, "baru.txt"), "utf8")).rejects.toThrow();
    expect(await readFile(join(ws, ".env"), "utf8")).toBe(
      "API_KEY=rahasia-penting",
    );
  });
});
