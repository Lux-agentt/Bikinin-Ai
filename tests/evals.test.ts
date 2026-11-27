// Eval API (Fitur 3): validasi 400, satu eval dalam satu waktu (409), dan
// happy path dengan spawn yang di-stub — tes ini TIDAK PERNAH menjalankan
// eval beneran (satu batch asli memakan 10-25 menit).
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { createAppServer } from "../src/server/http.js";
import { EvalManager, type EvalSpawn } from "../src/server/evals.js";
import { RunManager } from "../src/server/runs.js";

const cfg: Config = {
  providers: [
    {
      name: "t",
      baseUrl: "https://x.test/v1",
      apiKey: "SECRET_KEY_VALUE",
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

/**
 * Stub spawn: menulis output palsu ke stdout lalu menutup dengan exit code.
 * Timer (bukan microtask) supaya pipe ke file log sempat mengalirkan output
 * sebelum event close ditembakkan; `hang` = tidak pernah selesai (untuk 409).
 */
function fakeSpawn(
  opts: { output?: string; code?: number; hang?: boolean } = {},
): EvalSpawn {
  return (_file: string, _args: string[], _o: { cwd: string }) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const emitter = new EventEmitter();
    setTimeout(() => stdout.end(opts.output ?? ""), 5);
    if (!opts.hang)
      setTimeout(() => emitter.emit("close", opts.code ?? 0), 30);
    return {
      stdout,
      stderr,
      on: (ev: "close" | "error", cb: (arg?: unknown) => void) => {
        emitter.on(ev, cb as (...args: unknown[]) => void);
      },
    };
  };
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.();
});

async function boot(spawn: EvalSpawn) {
  const base = await mkdtemp(join(tmpdir(), "bikinin-eval-"));
  await mkdir(join(base, "ws"));
  const workspace = await realpath(join(base, "ws"));
  const manager = new RunManager(cfg, {
    workspace,
    systemPrompt: "sys",
  });
  const evals = new EvalManager(
    workspace,
    [{ name: "t", model: "test-model" }],
    { spawn },
  );
  const server = createAppServer(manager, workspace, evals);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  open.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, evals };
}

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function waitFor<T>(
  fn: () => Promise<T>,
  pred: (v: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() - start > timeoutMs)
      throw new Error("timeout menunggu kondisi");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("POST /api/evals", () => {
  it("400 untuk model yang tidak dikenal", async () => {
    const { url } = await boot(fakeSpawn());
    const r = await post(`${url}/api/evals`, { model: "tidak-ada" });
    expect(r.status).toBe(400);
    expect((await r.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("tidak dikenal"),
    });
  });

  it("400 untuk tugas yang tidak dikenal", async () => {
    const { url } = await boot(fakeSpawn());
    const r = await post(`${url}/api/evals`, {
      model: "t",
      tasks: ["tugas-ngarang"],
    });
    expect(r.status).toBe(400);
    expect((await r.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("tugas tidak dikenal"),
    });
  });

  it("409 saat masih ada eval yang berjalan", async () => {
    const { url } = await boot(fakeSpawn({ hang: true }));
    const first = await post(`${url}/api/evals`, { model: "t" });
    expect(first.status).toBe(201);
    const second = await post(`${url}/api/evals`, { model: "t" });
    expect(second.status).toBe(409);
  });

  it("happy path: 201, selesai, log tail terbaca, katalog 16 tugas", async () => {
    const { url } = await boot(
      fakeSpawn({ output: "Total: 1 lolos / 0 gagal\nLog: /x/evals/2026-01-01.json\n" }),
    );
    const started = await post(`${url}/api/evals`, {
      model: "test-model", // id model juga diterima, tercatat sebagai nama provider
      tasks: ["edge-empty-file"],
    });
    expect(started.status).toBe(201);
    const created = (await started.json()) as {
      eval: { id: string; model: string; tasks: string[]; status: string };
    };
    expect(created.eval.model).toBe("t");
    expect(created.eval.tasks).toEqual(["edge-empty-file"]);
    expect(created.eval.status).toBe("running");

    const done = await waitFor(
      async () =>
        (await (
          await fetch(`${url}/api/evals/${created.eval.id}`)
        ).json()) as { status: string; log: string },
      (d) => d.status === "done",
    );
    expect(done.log).toContain("Total: 1 lolos");

    const list = (await (await fetch(`${url}/api/evals`)).json()) as {
      tasks: Array<{ id: string }>;
      evals: Array<{ id: string; status: string }>;
    };
    expect(list.tasks).toHaveLength(16);
    expect(list.evals).toHaveLength(1);
    expect(list.evals[0]).toMatchObject({
      id: created.eval.id,
      status: "done",
    });
  });
});

describe("GET /api/evals/:id", () => {
  it("404 untuk id yang tidak ada", async () => {
    const { url } = await boot(fakeSpawn());
    const r = await fetch(`${url}/api/evals/eval_00000000`);
    expect(r.status).toBe(404);
  });
});
