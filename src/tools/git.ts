// Tool git (Fase 6, Track D): status, diff, log, commit, branch — only inside
// the session workspace, and only when the workspace IS a git repository.
// Runs via execFile("git", ["-C", workspace, ...]): no shell, no free-form
// command string. Network and destructive operations (push, fetch, pull,
// clone, reset --hard, clean, checkout) do not exist in the op enum, so the
// model cannot call them. Commit is local only (no push exists).
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AgentError } from "../errors.js";
import { safeEnv } from "./run-command.js";
import { defineTool, truncate, type FileChange } from "./types.js";

export const GIT_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 1 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 200;
const MAX_NAME_CHARS = 100;

interface GitResult {
  ok: boolean;
  code: number;
  timedOut: boolean;
  output: string;
}

function runGit(workspace: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", workspace, ...args],
      {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        env: { ...safeEnv(process.env), GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        const code =
          typeof error?.code === "number" ? error.code : error ? 1 : 0;
        const output = [stdout, stderr ? `[stderr]\n${stderr}` : ""]
          .filter(Boolean)
          .join("\n");
        resolve({
          ok: !error,
          code,
          timedOut: Boolean(error?.killed),
          output,
        });
      },
    );
  });
}

/** Short, single-line git failure message (stderr first, no huge dumps). */
function gitFailure(r: GitResult, what: string): AgentError {
  if (r.timedOut)
    return new AgentError(
      "tool_failed",
      `git ${what} timeout (${GIT_TIMEOUT_MS / 1000} dtk)`,
    );
  const detail = r.output
    .replace(/^\[stderr\]\n?/, "")
    .trim()
    .split("\n")[0];
  return new AgentError(
    "tool_failed",
    `git ${what} gagal (exit ${r.code})${detail ? `: ${detail}` : ""}`,
  );
}

async function assertGitRepo(workspace: string): Promise<void> {
  try {
    await access(join(workspace, ".git"));
  } catch {
    throw new AgentError(
      "tool_failed",
      "workspace bukan repositori git (tidak ada .git). Tool git hanya bekerja di workspace yang merupakan repo git.",
    );
  }
}

/** "XY path" per line; X = staged, Y = worktree. Rename: "R  old -> new". */
function parsePorcelain(output: string): FileChange[] {
  const changes: FileChange[] = [];
  for (const line of output.split("\n")) {
    if (line.length < 4) continue;
    const x = line[0];
    const y = line[1];
    let path = line.slice(3);
    const arrow = path.indexOf(" -> ");
    if (arrow >= 0) path = path.slice(arrow + 4);
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    const status = x !== " " && x !== "?" ? x : y;
    const op =
      status === "A" || status === "?"
        ? "created"
        : status === "D"
          ? "deleted"
          : "modified";
    changes.push({ path, op, bytes: 0 });
  }
  return changes;
}

const BRANCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

const gitSchema = z
  .object({
    op: z.enum(["status", "diff", "log", "commit", "branch"]),
    message: z
      .string()
      .trim()
      .max(
        MAX_MESSAGE_CHARS,
        `message commit maks ${MAX_MESSAGE_CHARS} karakter`,
      )
      .optional(),
    name: z
      .string()
      .trim()
      .max(MAX_NAME_CHARS, `nama branch maks ${MAX_NAME_CHARS} karakter`)
      .optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .superRefine((a, ctx) => {
    if (a.op === "commit") {
      if (!a.message || a.message.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["message"],
          message: "commit butuh message (tidak boleh kosong)",
        });
      } else if (/[\x00-\x1F\x7F]/.test(a.message)) {
        ctx.addIssue({
          code: "custom",
          path: ["message"],
          message:
            "message commit harus satu baris, tanpa karakter kontrol/newline",
        });
      }
    }
    if (a.op === "branch" && a.name !== undefined) {
      if (
        !BRANCH_NAME_RE.test(a.name) ||
        a.name.includes("..") ||
        a.name.includes("//") ||
        a.name.endsWith("/") ||
        a.name.endsWith(".lock")
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["name"],
          message: `nama branch tidak valid: '${a.name}'`,
        });
      }
    }
  });

export const gitTool = defineTool({
  name: "git",
  description:
    "Git di workspace sesi (status, diff, log, commit, branch). Hanya di dalam workspace dan hanya bila workspace adalah repo git. TIDAK ada push/fetch/pull/clone/reset/clean/checkout — operasi jaringan dan destruktif tidak tersedia. Commit lokal saja (git add -A + git commit -m, tanpa push) dan hanya men-stage file di workspace. readOnly: false karena commit dan branch menulis.",
  parameters: {
    type: "object",
    properties: {
      op: {
        type: "string",
        enum: ["status", "diff", "log", "commit", "branch"],
        description:
          "status: perubahan belum commit; diff: isi perubahan; log: riwayat commit; commit: commit lokal; branch: buat/lihat branch",
      },
      message: {
        type: "string",
        description:
          "Wajib untuk commit: satu baris, maks 200 karakter, tanpa karakter kontrol.",
      },
      name: {
        type: "string",
        description:
          "Untuk branch: nama branch baru yang dibuat. Tanpa name, branch hanya menampilkan daftar branch.",
      },
      limit: {
        type: "integer",
        description: "Jumlah commit untuk log (default 20, maks 50).",
      },
    },
    required: ["op"],
    additionalProperties: false,
  },
  readOnly: false,
  schema: gitSchema,
  label: (a) =>
    a.op === "commit"
      ? `git commit: ${(a.message ?? "").slice(0, 60)}`
      : a.op === "branch" && a.name
        ? `git branch ${a.name}`
        : `git ${a.op}`,
  publicArgs: (a) => ({
    op: a.op,
    ...(a.op === "branch" && a.name ? { name: a.name } : {}),
  }),
  async run(a, ctx) {
    await assertGitRepo(ctx.workspace);
    switch (a.op) {
      case "status": {
        const r = await runGit(ctx.workspace, [
          "status",
          "--short",
          "--branch",
        ]);
        if (!r.ok) throw gitFailure(r, "status");
        const lines = r.output
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        const branchLine = lines.find((l) => l.startsWith("## ")) ?? "";
        const changed = lines.filter((l) => !l.startsWith("## "));
        if (changed.length === 0) {
          return {
            ok: true,
            summary: `bersih (${branchLine.replace(/^## /, "") || "tanpa branch"})`,
            output: "Bersih: tidak ada perubahan.",
            changes: [],
          };
        }
        const { text } = truncate(changed.join("\n"));
        return {
          ok: true,
          summary: `${changed.length} file berubah`,
          output: text,
          changes: [],
        };
      }
      case "diff": {
        const stat = await runGit(ctx.workspace, ["diff", "--stat"]);
        if (!stat.ok) throw gitFailure(stat, "diff");
        if (stat.output.trim() === "") {
          return {
            ok: true,
            summary: "tidak ada perubahan terhadap file yang terlacak",
            output: "Tidak ada perubahan terhadap file yang terlacak.",
            changes: [],
          };
        }
        const body = await runGit(ctx.workspace, ["diff"]);
        if (!body.ok) throw gitFailure(body, "diff");
        const { text } = truncate(
          `${stat.output.trim()}\n\n${body.output.trim()}`,
        );
        return {
          ok: true,
          summary: "diff file yang terlacak",
          output: text,
          changes: [],
        };
      }
      case "log": {
        const r = await runGit(ctx.workspace, [
          "log",
          "--oneline",
          "-n",
          String(a.limit),
        ]);
        if (!r.ok) {
          if (r.output.includes("does not have any commits yet")) {
            return {
              ok: true,
              summary: "belum ada commit",
              output: "Belum ada commit di repo ini.",
              changes: [],
            };
          }
          throw gitFailure(r, "log");
        }
        const { text } = truncate(r.output.trim());
        return {
          ok: true,
          summary: `log (${r.output.trim().split("\n").filter(Boolean).length} commit)`,
          output: text,
          changes: [],
        };
      }
      case "commit": {
        const message = a.message as string; // validated non-empty by schema
        const status = await runGit(ctx.workspace, ["status", "--porcelain"]);
        if (!status.ok) throw gitFailure(status, "status");
        const changes = parsePorcelain(status.output);
        if (changes.length === 0) {
          return {
            ok: true,
            summary: "tidak ada perubahan untuk di-commit",
            output: "Tidak ada perubahan untuk di-commit.",
            changes: [],
          };
        }
        const add = await runGit(ctx.workspace, ["add", "-A"]);
        if (!add.ok) throw gitFailure(add, "add");
        const commit = await runGit(ctx.workspace, ["commit", "-m", message]);
        if (!commit.ok) throw gitFailure(commit, "commit");
        const head = await runGit(ctx.workspace, [
          "rev-parse",
          "--short",
          "HEAD",
        ]);
        const hash = head.ok ? head.output.trim() : "?";
        return {
          ok: true,
          summary: `commit ${hash}: ${message}`,
          output: `Commit ${hash} dibuat (${changes.length} file):\n${changes
            .map((c) => `${c.op} ${c.path}`)
            .join("\n")}`,
          changes,
        };
      }
      case "branch": {
        if (a.name) {
          const check = await runGit(ctx.workspace, [
            "check-ref-format",
            "--branch",
            a.name,
          ]);
          if (!check.ok)
            throw new AgentError(
              "tool_failed",
              `nama branch tidak valid menurut git: '${a.name}'`,
            );
          const r = await runGit(ctx.workspace, ["branch", a.name]);
          if (!r.ok) throw gitFailure(r, "branch");
          return {
            ok: true,
            summary: `branch '${a.name}' dibuat`,
            output: `Branch '${a.name}' dibuat.`,
            changes: [],
          };
        }
        const r = await runGit(ctx.workspace, ["branch", "--list"]);
        if (!r.ok) throw gitFailure(r, "branch");
        const lines = r.output
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        const { text } = truncate(lines.join("\n"));
        return {
          ok: true,
          summary: `${lines.length} branch`,
          output: text || "(tidak ada branch)",
          changes: [],
        };
      }
    }
  },
});
