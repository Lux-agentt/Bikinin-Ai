// Eval runs (Fitur 3): runs `scripts/eval.ts` as a child process and tracks
// it in memory. One eval at a time; records are in-memory like runs (a
// restart forgets them, the log files in workspace/.bikinin/evals stay).
// The child runs with an argv array, no shell. Its console output streams
// to <workspace>/.bikinin/evals/<id>.log as it arrives, so the UI can show
// a live tail while the eval runs (~10-25 menit for a full batch).
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TASKS } from "../eval/tasks.js";

export type EvalStatus = "running" | "done" | "failed";

export interface EvalRecord {
  id: string;
  /** Resolved provider name (what scripts/eval.ts --model takes). */
  model: string;
  /** Resolved task ids (all 16 when the request omits them). */
  tasks: string[];
  status: EvalStatus;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  /** Absolute path of the captured console log. */
  logPath: string;
}

export interface EvalProvider {
  name: string;
  model: string;
}

/** Minimal child-process shape the manager needs (execFile's return fits). */
export interface EvalChild {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: "close" | "error", cb: (arg?: unknown) => void): void;
}

export type EvalSpawn = (
  file: string,
  args: string[],
  opts: { cwd: string },
) => EvalChild;

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
/** Eval console output is small (a table + totals); 8 MB is a safe cap. */
const MAX_LOG_BUFFER = 8 * 1024 * 1024;
const LOG_TAIL_LINES = 60;

function defaultSpawn(
  file: string,
  args: string[],
  opts: { cwd: string },
): EvalChild {
  // The empty callback keeps execFile buffering the output (maxBuffer) while
  // the manager also pipes the streams to the log file as it arrives.
  return execFile(
    file,
    args,
    { cwd: opts.cwd, maxBuffer: MAX_LOG_BUFFER },
    () => {},
  );
}

export class EvalManager {
  private readonly records = new Map<string, EvalRecord>();

  constructor(
    private readonly workspace: string,
    private readonly providers: EvalProvider[],
    private readonly opts: { spawn?: EvalSpawn; repoRoot?: string } = {},
  ) {}

  private get spawn(): EvalSpawn {
    return this.opts.spawn ?? defaultSpawn;
  }

  private get repoRoot(): string {
    return this.opts.repoRoot ?? REPO_ROOT;
  }

  private get evalsDir(): string {
    return join(this.workspace, ".bikinin", "evals");
  }

  /** All records, newest first. */
  list(): EvalRecord[] {
    return [...this.records.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  }

  get(id: string): EvalRecord | undefined {
    return this.records.get(id);
  }

  /** The 16 benchmark tasks, for the UI's task picker. */
  taskCatalog(): Array<{ id: string; title: string; category: string }> {
    return TASKS.map((t) => ({ id: t.id, title: t.title, category: t.category }));
  }

  running(): EvalRecord | undefined {
    return [...this.records.values()].find((r) => r.status === "running");
  }

  start(
    model: unknown,
    tasks: unknown,
  ):
    | { record: EvalRecord }
    | { error: "bad-model" | "bad-tasks" | "busy"; message: string } {
    if (typeof model !== "string" || model.trim() === "") {
      return {
        error: "bad-model",
        message: "model harus diisi (nama provider)",
      };
    }
    // Resolve by provider name first (what scripts/eval.ts --model takes),
    // then by model id (what the composer shows) — the first provider with
    // that model wins when several share one.
    const provider =
      this.providers.find((p) => p.name === model) ??
      this.providers.find((p) => p.model === model);
    if (!provider) {
      const names = this.providers.map((p) => p.name).join(", ") || "—";
      return {
        error: "bad-model",
        message: `provider "${model}" tidak dikenal. Pilihan: ${names}`,
      };
    }
    let resolved: string[];
    if (tasks === undefined) {
      resolved = TASKS.map((t) => t.id);
    } else {
      if (!Array.isArray(tasks) || tasks.some((t) => typeof t !== "string")) {
        return {
          error: "bad-tasks",
          message: "tasks harus berupa daftar id tugas",
        };
      }
      const unknown = (tasks as string[]).filter(
        (id) => !TASKS.some((t) => t.id === id),
      );
      if (unknown.length > 0) {
        return {
          error: "bad-tasks",
          message: `tugas tidak dikenal: ${unknown.join(", ")}`,
        };
      }
      resolved =
        tasks.length > 0 ? [...(tasks as string[])] : TASKS.map((t) => t.id);
    }
    if (this.running()) {
      return { error: "busy", message: "masih ada eval yang berjalan" };
    }
    const id = `eval_${randomUUID().slice(0, 8)}`;
    const record: EvalRecord = {
      id,
      model: provider.name,
      tasks: resolved,
      status: "running",
      startedAt: Date.now(),
      logPath: join(this.evalsDir, `${id}.log`),
    };
    this.records.set(id, record);
    void this.run(record, provider.name);
    return { record };
  }

  private async run(record: EvalRecord, providerName: string): Promise<void> {
    await mkdir(this.evalsDir, { recursive: true }).catch(() => {});
    const logStream = createWriteStream(record.logPath);
    const args = [
      "tsx",
      "scripts/eval.ts",
      "--model",
      providerName,
      "--tasks",
      record.tasks.join(","),
      "--out-dir",
      this.evalsDir,
    ];
    let child: EvalChild;
    try {
      child = this.spawn("npx", args, { cwd: this.repoRoot });
    } catch (err) {
      logStream.end(
        `Gagal menjalankan eval: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      record.status = "failed";
      record.finishedAt = Date.now();
      record.exitCode = null;
      return;
    }
    child.stdout?.pipe(logStream, { end: false });
    child.stderr?.pipe(logStream, { end: false });
    const code = await new Promise<number | null>((resolve) => {
      child.on("close", (c) => resolve(typeof c === "number" ? c : null));
      child.on("error", () => resolve(null));
    });
    // Flush the piped output before marking done, so the tail is complete.
    await new Promise<void>((resolve) => logStream.end(() => resolve()));
    record.status = code === 0 ? "done" : "failed";
    record.finishedAt = Date.now();
    record.exitCode = code;
  }

  /** Last 60 lines of the eval's console log ("" while nothing is written). */
  async logTail(id: string, maxLines = LOG_TAIL_LINES): Promise<string> {
    const rec = this.records.get(id);
    if (!rec) return "";
    const text = await readFile(rec.logPath, "utf8").catch(() => "");
    if (!text) return "";
    const lines = text.replace(/\n$/, "").split("\n");
    return lines.slice(-maxLines).join("\n");
  }
}
