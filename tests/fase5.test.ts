// Fase 5 tests: web_search parsing, update_plan, plan-first, retry budget,
// read cache, within-run compaction, delegate/subagent, checkpoint HTTP.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { runAgent, type AgentDeps } from "../src/agent/loop.js";
import {
  createDelegateRunner,
  activeSubagentCount,
} from "../src/agent/subagent.js";
import {
  createEmitter,
  type AgentEvent,
  type EventType,
} from "../src/events.js";
import type { ChatResult, LlmClient, ToolCallReq } from "../src/llm/client.js";
import type { Config } from "../src/config.js";
import { createAppServer } from "../src/server/http.js";
import { RunManager } from "../src/server/runs.js";
import { readSessionEvents } from "../src/server/event-log.js";
import {
  createCheckpoint,
} from "../src/server/checkpoints.js";
import { getTool, toolSpecsForLlm } from "../src/tools/registry.js";
import {
  parseDuckDuckGoLite,
  searchWeb,
} from "../src/tools/web-search.js";
import { tempWorkspace } from "./helpers.js";

const usage = { input_tokens: 100, output_tokens: 20, cached_tokens: 0 };

function call(id: string, name: string, args: unknown): ToolCallReq {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}
const withCalls = (...toolCalls: ToolCallReq[]): ChatResult => ({
  text: "",
  toolCalls,
  usage,
});
const finalText = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  usage,
});

function scripted(responses: ChatResult[]): LlmClient {
  let i = 0;
  return {
    async chat(p) {
      const r = responses[i++];
      if (!r) throw new Error("skrip habis");
      if (r.text) p.onText?.(r.text);
      return r;
    },
  };
}

function ofType<T extends EventType>(events: AgentEvent[], type: T) {
  return events.filter(
    (e): e is Extract<AgentEvent, { type: T }> => e.type === type,
  );
}

async function run(
  responses: ChatResult[],
  overrides: Partial<AgentDeps> = {},
  premadeWorkspace?: string,
) {
  const workspace = premadeWorkspace ?? (await tempWorkspace());
  const events: AgentEvent[] = [];
  const emit = createEmitter("run_test", (e) => events.push(e));
  const deps: AgentDeps = {
    llm: scripted(responses),
    model: "test-model",
    systemPrompt: "sys",
    message: "tes",
    sessionId: "s_test",
    workspace,
    limits: { maxCostUsd: 1 },
    prices: { inPerM: 1, outPerM: 2 },
    emit,
    approve: async () => false,
    ...overrides,
  };
  const result = await runAgent(deps);
  return { workspace, events, result };
}

const DDG_FIXTURE = `
<table><tr><td>
<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.remotion.dev%2Fdocs%2Frender%2F&amp;rut=abc" class='result-link'>Render your video | Remotion</a>
</td></tr><tr><td class='result-snippet'>
Render a <b>video</b> using render CLI command.
</td></tr>
<tr><td>
<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=def" class='result-link'>Example Page</a>
</td></tr><tr><td class='result-snippet'>
Just an example snippet.
</td></tr></table>`;

describe("web_search", () => {
  it("parse DuckDuckGo Lite: judul, URL asli (uddg), dan cuplikan", () => {
    const results = parseDuckDuckGoLite(DDG_FIXTURE);
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe("Render your video | Remotion");
    expect(results[0].url).toBe("https://www.remotion.dev/docs/render/");
    expect(results[0].snippet).toContain("Render a video using render CLI");
    expect(results[1].url).toBe("https://example.com/page");
  });

  it("searchWeb memakai fetch stub (tanpa jaringan) dan memotong ke 5 hasil", async () => {
    const big = DDG_FIXTURE.repeat(4);
    const stub = (async () => ({ ok: true, text: async () => big })) as unknown as typeof fetch;
    const results = await searchWeb("remotion render", stub);
    expect(results.length).toBeLessThanOrEqual(5);
    expect(results[0].url).toContain("remotion.dev");
  });

  it("query mirip rahasia ditolak sebelum fetch dipanggil", async () => {
    let called = false;
    const stub = (async () => {
      called = true;
      return { ok: true, text: async () => "" };
    }) as unknown as typeof fetch;
    await expect(
      searchWeb("sk-abcdefghijklmnop123456", stub),
    ).rejects.toThrow(/rahasia/);
    expect(called).toBe(false);
  });

  it("tiga tool Fase 5 terdaftar dan terlihat oleh model", () => {
    for (const name of ["web_search", "update_plan", "delegate"]) {
      expect(getTool(name)?.name).toBe(name);
    }
    // toolSpecsForLlm returns the OpenAI ChatCompletionTool union
    // (function | custom); all specs built here are function tools.
    const names = toolSpecsForLlm().map((t) =>
      t.type === "function" ? t.function.name : "",
    );
    expect(names).toContain("web_search");
    expect(names).toContain("update_plan");
    expect(names).toContain("delegate");
  });
});

describe("update_plan", () => {
  it("parse + run mengembalikan ringkasan rencana", async () => {
    const tool = getTool("update_plan");
    expect(tool).toBeDefined();
    const parsed = tool!.parse({
      items: [
        { text: "Buat index.html", status: "doing" },
        { text: "Uji di browser", status: "pending" },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const res = await parsed.execute({ workspace: await tempWorkspace() });
      expect(res.ok).toBe(true);
      expect(res.summary).toBe("rencana: 0/2 selesai");
    }
  });
});

describe("plan-first", () => {
  it("tool pertama tanpa rencana dibuang; rencana dibuat dulu, baru kerja", async () => {
    const { workspace, events, result } = await run([
      withCalls(
        call("c1", "write_file", { path: "a.txt", content: "SALAH" }),
      ),
      withCalls(
        call("c2", "update_plan", {
          items: [{ text: "Tulis a.txt", status: "doing" }],
        }),
      ),
      withCalls(
        call("c3", "write_file", { path: "a.txt", content: "BENAR" }),
      ),
      finalText("selesai"),
    ]);
    expect(result.status).toBe("completed");
    expect(ofType(events, "plan_updated")).toHaveLength(1);
    expect(ofType(events, "plan_updated")[0].items[0].text).toBe("Tulis a.txt");
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("BENAR");
  });
});

describe("retry budget", () => {
  it("panggilan sama gagal 3x -> satu giliran diagnosis, gagal 3x lagi -> run berhenti", async () => {
    const missing = () =>
      withCalls(call(`c${Math.random()}`, "read_file", { path: "tidak-ada.txt" }));
    const { events, result } = await run([
      withCalls(
        call("c0", "update_plan", {
          items: [{ text: "Baca file", status: "doing" }],
        }),
      ),
      missing(),
      missing(),
      missing(),
      missing(),
      missing(),
      missing(),
      finalText("seharusnya tidak sampai sini"),
    ]);
    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/3x berturut-turut/);
    expect(ofType(events, "error").some((e) => !e.retryable)).toBe(true);
  });

  it("giliran diagnosis: agent memeriksa dulu, lalu run selesai", async () => {
    const seenMessages: Array<Array<{ role?: string; content?: unknown }>> =
      [];
    const responses: ChatResult[] = [
      withCalls(
        call("c0", "update_plan", {
          items: [{ text: "Baca file", status: "doing" }],
        }),
      ),
      withCalls(call("c1", "read_file", { path: "tidak-ada.txt" })),
      withCalls(call("c2", "read_file", { path: "tidak-ada.txt" })),
      withCalls(call("c3", "read_file", { path: "tidak-ada.txt" })),
      // Giliran diagnosis: agent menjalankan satu pemeriksaan yang
      // membedakan (bukan mengulang read_file yang sama).
      withCalls(call("c4", "list_dir", { path: "." })),
      finalText("file memang tidak ada, dibuat baru"),
    ];
    let i = 0;
    const recording: LlmClient = {
      async chat(p) {
        seenMessages.push(p.messages as Array<{
          role?: string;
          content?: unknown;
        }>);
        const r = responses[i++];
        if (!r) throw new Error("skrip habis");
        if (r.text) p.onText?.(r.text);
        return r;
      },
    };
    const workspace = await tempWorkspace();
    const events: AgentEvent[] = [];
    const emit = createEmitter("run_test", (e) => events.push(e));
    const result = await runAgent({
      llm: recording,
      model: "test-model",
      systemPrompt: "sys",
      message: "tes",
      sessionId: "s_test",
      workspace,
      limits: { maxCostUsd: 1 },
      prices: { inPerM: 1, outPerM: 2 },
      emit,
      approve: async () => false,
    });
    expect(result.status).toBe("completed");
    // Pesan diagnosis benar-benar disuntikkan ke riwayat sebelum giliran
    // pemeriksaan — agent tidak langsung berhenti di 3x pertama.
    const diagnosisSeen = seenMessages.some((msgs) =>
      msgs.some(
        (m) =>
          m.role === "system" &&
          typeof m.content === "string" &&
          m.content.includes("hipotesis penyebabnya"),
      ),
    );
    expect(diagnosisSeen).toBe(true);
    expect(ofType(events, "tool_call_finished")).toHaveLength(5);
  });
});

describe("read cache", () => {
  it("baca kedua file yang sama mengembalikan catatan cache, bukan isi file", async () => {
    const workspace = await tempWorkspace();
    await writeFile(join(workspace, "index.html"), "<h1>hello</h1>");
    const { result } = await run(
      [
        withCalls(
          call("c1", "update_plan", {
            items: [{ text: "Baca index", status: "doing" }],
          }),
        ),
        withCalls(call("c2", "read_file", { path: "index.html" })),
        withCalls(call("c3", "read_file", { path: "index.html" })),
        finalText("selesai"),
      ],
      {},
      workspace,
    );
    expect(result.status).toBe("completed");
    const toolMsgs = result.transcript.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(3);
    expect(toolMsgs[2].content).toContain("(cache)");
    expect(toolMsgs[1].content).not.toContain("(cache)");
  });

  it("setelah edit_file, baca berikutnya bukan dari cache", async () => {
    const workspace = await tempWorkspace();
    await writeFile(join(workspace, "index.html"), "hello");
    const { result } = await run(
      [
        withCalls(
          call("c1", "update_plan", {
            items: [{ text: "Baca lalu edit", status: "doing" }],
          }),
        ),
        withCalls(call("c2", "read_file", { path: "index.html" })),
        withCalls(
          call("c3", "edit_file", {
            path: "index.html",
            old_str: "hello",
            new_str: "halo",
          }),
        ),
        withCalls(call("c4", "read_file", { path: "index.html" })),
        finalText("selesai"),
      ],
      {},
      workspace,
    );
    expect(result.status).toBe("completed");
    const toolMsgs = result.transcript.filter((m) => m.role === "tool");
    // Hanya hasil read_file yang cocok: "OK: index.html (N baris)" atau cache.
    const reads = toolMsgs.filter(
      (m) =>
        typeof m.content === "string" &&
        (m.content.includes("baris)") || m.content.includes("OK (cache)")),
    );
    expect(reads).toHaveLength(2);
    expect(reads[1].content).not.toContain("(cache)");
    expect(reads[1].content).toContain("halo");
  });

  it("baca ulang file panjang dengan max_lines lebih besar bukan dari cache", async () => {
    // Regresi live 2026-11-28: Scene6.tsx dibaca ulang berkali-kali
    // (49 perintah, 475 dtk) untuk cari durasi di akhir file — read_file
    // default cuma 400 baris, dan cache lama mengunci di path saja,
    // sehingga baca ulang itu selalu dijawab catatan cache tanpa pernah
    // memperlihatkan baris 401+.
    const workspace = await tempWorkspace();
    const lines = Array.from(
      { length: 500 },
      (_, i) => `baris ke-${i + 1}`,
    );
    lines[449] = "BARIS-450-MARKER durasi";
    await writeFile(join(workspace, "panjang.tsx"), lines.join("\n"));
    const { result } = await run(
      [
        withCalls(
          call("c1", "update_plan", {
            items: [{ text: "Baca file panjang", status: "doing" }],
          }),
        ),
        withCalls(call("c2", "read_file", { path: "panjang.tsx" })),
        withCalls(
          call("c3", "read_file", { path: "panjang.tsx", max_lines: 2000 }),
        ),
        finalText("selesai"),
      ],
      {},
      workspace,
    );
    expect(result.status).toBe("completed");
    const toolMsgs = result.transcript.filter((m) => m.role === "tool");
    const reads = toolMsgs.filter(
      (m) =>
        typeof m.content === "string" &&
        (m.content.includes("baris)") || m.content.includes("OK (cache)")),
    );
    expect(reads).toHaveLength(2);
    expect(reads[0].content).not.toContain("BARIS-450-MARKER");
    expect(reads[1].content).not.toContain("(cache)");
    expect(reads[1].content).toContain("BARIS-450-MARKER");
  });
});

describe("batch campuran: baca paralel, tulis berurutan", () => {
  it("baca sesudah tulis melihat isi baru (urutan tetap dijaga)", async () => {
    // Paralel (aturan user 2026-11-28): tool baca yang berurutan dalam
    // satu batch jalan bareng, tool tulis tetap satu-per-satu. Tes ini
    // menjaga urutannya: baca sesudah tulis HARUS melihat isi baru —
    // kalau baca itu ikut paralel dengan tulisnya, isinya masih "lama".
    const workspace = await tempWorkspace();
    await writeFile(join(workspace, "a.txt"), "lama");
    await writeFile(join(workspace, "b.txt"), "isi-b");
    const { result } = await run(
      [
        withCalls(
          call("c1", "update_plan", {
            items: [{ text: "Baca, tulis, baca lagi", status: "doing" }],
          }),
        ),
        withCalls(
          call("c2", "read_file", { path: "a.txt" }),
          call("c3", "read_file", { path: "b.txt" }),
          call("c4", "write_file", { path: "a.txt", content: "baru" }),
          call("c5", "read_file", { path: "a.txt" }),
        ),
        finalText("selesai"),
      ],
      {},
      workspace,
    );
    expect(result.status).toBe("completed");
    const toolMsgs = result.transcript.filter((m) => m.role === "tool");
    const reads = toolMsgs.filter(
      (m) =>
        typeof m.content === "string" &&
        (m.content.includes("baris)") || m.content.includes("OK (cache)")),
    );
    expect(reads).toHaveLength(3);
    expect(reads[0].content).toContain("lama");
    expect(reads[1].content).toContain("isi-b");
    expect(reads[2].content).not.toContain("(cache)");
    expect(reads[2].content).toContain("baru");
  });
});

describe("compaction dalam run", () => {
  it("hasil tool lama dipotong saat konteks melewati batas", async () => {
    const workspace = await tempWorkspace();
    for (let i = 1; i <= 13; i++) {
      await writeFile(join(workspace, `f${i}.txt`), "x".repeat(50_000));
    }
    const responses: ChatResult[] = [
      withCalls(
        call("c0", "update_plan", {
          items: [{ text: "Baca 13 file", status: "doing" }],
        }),
      ),
      ...Array.from({ length: 13 }, (_, i) =>
        withCalls(call(`c${i + 1}`, "read_file", { path: `f${i + 1}.txt` })),
      ),
      finalText("selesai"),
    ];
    const events: AgentEvent[] = [];
    const emit = createEmitter("run_test", (e) => events.push(e));
    const result = await runAgent({
      llm: scripted(responses),
      model: "test-model",
      systemPrompt: "sys",
      message: "tes",
      sessionId: "s_test",
      workspace,
      limits: { maxCostUsd: 1 },
      prices: { inPerM: 1, outPerM: 2 },
      emit,
      approve: async () => false,
    });
    expect(result.status).toBe("completed");
    const toolMsgs = result.transcript.filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBe(14); // 1 plan + 13 reads
    const firstRead = toolMsgs.find(
      (m) => typeof m.content === "string" && m.content.includes("f1.txt"),
    );
    expect(firstRead).toBeDefined();
    expect(firstRead!.content).toContain("dipotong untuk hemat konteks");
    const lastRead = toolMsgs.find(
      (m) => typeof m.content === "string" && m.content.includes("f13.txt"),
    );
    expect(lastRead!.content).not.toContain("dipotong untuk hemat konteks");
  });
});

describe("delegate / subagent", () => {
  it("subagent membaca file, ringkasannya kembali, biayanya masuk total run", async () => {
    const workspace = await tempWorkspace();
    await writeFile(join(workspace, "index.html"), "<h1>hello</h1>");
    const { events, result } = await run(
      [
        withCalls(
          call("c1", "update_plan", {
            items: [{ text: "Riset isi index", status: "doing" }],
          }),
        ),
        withCalls(
          call("c2", "delegate", { task: "Baca index.html dan ringkas isinya" }),
        ),
        withCalls(call("c3", "read_file", { path: "index.html" })),
        finalText("temuan: ada index.html"),
        finalText("selesai"),
      ],
      {},
      workspace,
    );
    expect(result.status).toBe("completed");
    expect(ofType(events, "subagent_started")).toHaveLength(1);
    const finished = ofType(events, "subagent_finished");
    expect(finished).toHaveLength(1);
    expect(finished[0].steps).toBe(1);
    expect(finished[0].cost_usd).toBeGreaterThan(0);
    // main: plan(1) + delegate(1) = 2, + subagent(1) = 3 langkah.
    expect(result.totals.steps).toBe(3);
    expect(result.totals.cost_usd).toBeGreaterThan(0);
  });

  it("subagent tidak bisa menulis file (tool tidak tersedia untuknya)", async () => {
    const workspace = await tempWorkspace();
    const { result } = await run(
      [
        withCalls(
          call("c1", "update_plan", {
            items: [{ text: "Coba tulis", status: "doing" }],
          }),
        ),
        withCalls(call("c2", "delegate", { task: "Buat file baru" })),
        withCalls(
          call("c3", "write_file", { path: "baru.txt", content: "x" }),
        ),
        finalText("tidak bisa menulis"),
        finalText("selesai"),
      ],
      {},
      workspace,
    );
    // File yang coba ditulis subagent TIDAK terbentuk.
    await expect(readFile(join(workspace, "baru.txt"), "utf8")).rejects.toThrow();
    const delegateMsg = result.transcript.find(
      (m) =>
        m.role === "tool" &&
        typeof m.content === "string" &&
        m.content.includes("subagent:"),
    );
    expect(delegateMsg).toBeDefined();
    expect(delegateMsg!.content).toContain("tidak bisa menulis");
  });

  it("maks 5 subagent bersamaan; yang keenam langsung ditolak (fail fast)", async () => {
    const workspace = await tempWorkspace();
    const events: AgentEvent[] = [];
    const emit = createEmitter("run_test", (e) => events.push(e));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fakeSub = {
      status: "completed",
      summary: "ok",
      totals: {
        steps: 1,
        input_tokens: 10,
        output_tokens: 5,
        cached_tokens: 0,
        cost_usd: 0.001,
      },
      durationMs: 1,
      filesCreated: [],
      filesChanged: [],
      transcript: [],
    };
    const runner = createDelegateRunner({
      llm: scripted([]),
      model: "test-model",
      prices: { inPerM: 1, outPerM: 2 },
      workspace,
      emit,
      runAgentImpl: (async () => {
        await gate;
        return fakeSub;
      }) as (d: AgentDeps) => Promise<import("../src/agent/loop.js").AgentResult>,
      charge: () => {},
    });
    const ps = [
      runner("tugas 1"),
      runner("tugas 2"),
      runner("tugas 3"),
      runner("tugas 4"),
      runner("tugas 5"),
    ];
    // Beri kesempatan kelima runner masuk ke gate.
    await new Promise((r) => setTimeout(r, 10));
    expect(activeSubagentCount()).toBe(5);
    const sixth = await runner("tugas 6");
    expect(sixth.status).toBe("error");
    expect(sixth.summary).toMatch(/sibuk/);
    release();
    const rs = await Promise.all(ps);
    for (const r of rs) expect(r.status).toBe("completed");
    expect(activeSubagentCount()).toBe(0);
    void events;
  });

  it("delegate read-only: beberapa delegate dalam satu batch jalan bareng", async () => {
    // Subagent cuma punya tool baca, jadi delegate ditandai readOnly dan
    // batch [delegate, delegate] dieksekusi paralel oleh loop (bukan
    // satu-per-satu). Dua subagent berbagi antrean scripted yang sama:
    // tiap subagent butuh 1 baca + 1 jawaban akhir, jadi skripnya 7
    // respons (rencana + batch delegate + 2×(baca + akhir) + akhir utama)
    // — urutan konsumsi antar-subagent boleh tertukar, keduanya tetap
    // selesai karena tiap subagent cuma butuh 1 baca + 1 akhir.
    expect(getTool("delegate")?.readOnly).toBe(true);
    const workspace = await tempWorkspace();
    await writeFile(join(workspace, "a.txt"), "isi-a");
    await writeFile(join(workspace, "b.txt"), "isi-b");
    const { result } = await run(
      [
        withCalls(
          call("c1", "update_plan", {
            items: [{ text: "Riset dua file bareng", status: "doing" }],
          }),
        ),
        withCalls(
          call("c2", "delegate", { task: "Baca a.txt dan ringkas" }),
          call("c3", "delegate", { task: "Baca b.txt dan ringkas" }),
        ),
        withCalls(call("c4", "read_file", { path: "a.txt" })),
        finalText("ringkas a"),
        withCalls(call("c5", "read_file", { path: "b.txt" })),
        finalText("ringkas b"),
        finalText("selesai"),
      ],
      {},
      workspace,
    );
    expect(result.status).toBe("completed");
    const subs = result.transcript.filter(
      (m) =>
        m.role === "tool" &&
        typeof m.content === "string" &&
        m.content.includes("subagent:"),
    );
    expect(subs).toHaveLength(2);
    for (const s of subs) expect(s.content).toContain("completed");
  });
});

describe("checkpoint HTTP", () => {
  const cfg: Config = {
    providers: [
      {
        name: "t",
        baseUrl: "https://x.test/v1",
        apiKey: "test-key",
        model: "test-model",
        inPerM: 1,
        outPerM: 2,
      },
    ],
    BIKININ_USD_IDR: 17000,
    BIKININ_MAX_COST_USD: 1,
    BIKININ_WORKSPACE: "./workspace",
    BIKININ_MAX_VIDEO_SECONDS: 30,
  };
  const servers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (servers.length > 0) await servers.pop()?.();
  });

  it("GET list + POST restore, dan restore tercatat sebagai event", async () => {
    const workspace = await tempWorkspace();
    await writeFile(join(workspace, "index.html"), "v1");
    const cp = await createCheckpoint(workspace, "s_test", "run_test");
    const manager = new RunManager(cfg, {
      workspace,
      systemPrompt: "sys",
      llm: scripted([finalText("ok")]),
    });
    await manager.init();
    const server = createAppServer(manager, workspace);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    servers.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    const listRes = await fetch(`${base}/api/checkpoints`);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as Array<{ id: string }>;
    expect(list.map((c) => c.id)).toContain(cp.id);

    await writeFile(join(workspace, "index.html"), "v2-rusak");
    const restoreRes = await fetch(
      `${base}/api/checkpoints/${cp.id}/restore`,
      { method: "POST" },
    );
    expect(restoreRes.status).toBe(200);
    const body = (await restoreRes.json()) as { files_restored: number };
    expect(body.files_restored).toBeGreaterThan(0);
    expect(await readFile(join(workspace, "index.html"), "utf8")).toBe("v1");

    const events = await readSessionEvents(workspace, "s_test");
    expect(
      events.some((e) => e.type === "checkpoint_restored"),
    ).toBe(true);

    const missing = await fetch(
      `${base}/api/checkpoints/cp_00000000/restore`,
      { method: "POST" },
    );
    expect(missing.status).toBe(404);
  });
});
