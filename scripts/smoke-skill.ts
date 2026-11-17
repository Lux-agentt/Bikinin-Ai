// Smoke test Fase 2: the same website task twice — once with the website
// skill available, once without — using a scripted fake LLM.
// The fake is deterministic on purpose: it proves the WIRING (the agent reads
// the skill before building, and the skill changes the output structure), not
// a live model's judgment. A real-model comparison needs a configured provider.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../src/agent/loop.js";
import { createEmitter, type AgentEvent } from "../src/events.js";
import type { ChatResult, LlmClient, ToolCallReq } from "../src/llm/client.js";
import { loadSystemPrompt } from "../src/prompt.js";
import {
  formatSkillList,
  listSkills,
  REPO_SKILLS_DIR,
} from "../src/skills/loader.js";

const usage = { input_tokens: 100, output_tokens: 20, cached_tokens: 0 };

function call(id: string, name: string, args: unknown): ToolCallReq {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

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

const withCalls = (...toolCalls: ToolCallReq[]): ChatResult => ({
  text: "",
  toolCalls,
  usage,
});
const finalText = (text: string): ChatResult => ({ text, toolCalls: [], usage });

// A page built FOLLOWING skills/website/SKILL.md: semantic, responsive,
// accessible, real copy.
const GOOD_HTML = `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kedai Kopi Senja — Kopi tubruk asli sejak 2019</title>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#1a120b;color:#f5ead9}
@media (min-width:768px){.hero{padding:64px}}
button{min-height:44px}
</style>
</head>
<body>
<header><nav aria-label="Navigasi utama"><a href="#menu">Menu</a></nav></header>
<main>
<section class="hero"><h1>Kopi tubruk asli, diseduh pelan setiap pagi</h1>
<p>Kedai Kopi Senja di Bandung. Biji arabika dari Gayo, disangrai tiap minggu.</p>
<button type="button">Lihat menu hari ini</button></section>
<section id="menu"><h2>Menu andalan</h2><p>Es kopi senja Rp18.000, tubruk gula aren Rp15.000.</p></section>
</main>
<footer><p>Buka 07.00–21.00, Jl. Braga No. 12.</p></footer>
</body>
</html>
`;

// A page built WITHOUT the skill: div soup, no viewport, placeholder text.
const BAD_HTML = `<!doctype html>
<html>
<head><title>Judul di sini</title></head>
<body>
<div><div>Lorem ipsum dolor sit amet</div><div><a href="#">Klik di sini</a></div></div>
</body>
</html>
`;

const CHECKS: Array<[string, (html: string) => boolean]> = [
  ["meta viewport", (h) => h.includes('name="viewport"')],
  ["header/main/footer semantik", (h) => h.includes("<header") && h.includes("<main") && h.includes("<footer")],
  ["aria-label", (h) => h.includes("aria-label")],
  ["CSS responsif (@media)", (h) => h.includes("@media")],
  ["tanpa lorem ipsum", (h) => !/lorem/i.test(h)],
  ["judul bermakna", (h) => !h.includes("Judul di sini")],
];

async function oneRun(opts: {
  withSkill: boolean;
  responses: ChatResult[];
}): Promise<{ workspace: string; events: AgentEvent[]; html: string }> {
  const workspace = await mkdtemp(join(tmpdir(), "bikinin-skill-"));
  const events: AgentEvent[] = [];
  const emit = createEmitter("run_smoke", (e) => events.push(e));
  const systemPrompt = opts.withSkill
    ? await loadSystemPrompt(
        formatSkillList(await listSkills(REPO_SKILLS_DIR)),
      )
    : await loadSystemPrompt();
  await runAgent({
    llm: scripted(opts.responses),
    model: "smoke-model",
    systemPrompt,
    message: "Buatkan landing page kedai kopi",
    sessionId: "s_smoke",
    workspace,
    limits: { maxSteps: 10, maxCostUsd: 1 },
    prices: { inPerM: 1, outPerM: 2 },
    emit,
    approve: async () => false,
  });
  const html = await readFile(join(workspace, "index.html"), "utf8");
  return { workspace, events, html };
}

async function main(): Promise<void> {
  const withSkill = await oneRun({
    withSkill: true,
    responses: [
      withCalls(call("c1", "read_skill", { name: "website" })),
      withCalls(call("c2", "write_file", { path: "index.html", content: GOOD_HTML })),
      finalText("Selesai: landing page kedai kopi sudah jadi dan diuji."),
    ],
  });
  const withoutSkill = await oneRun({
    withSkill: false,
    responses: [
      withCalls(call("c1", "write_file", { path: "index.html", content: BAD_HTML })),
      finalText("Selesai."),
    ],
  });

  const toolOrder = (events: AgentEvent[]): string[] =>
    events
      .filter((e) => e.type === "tool_call_started")
      .map((e) => (e as { tool: string }).tool);
  const readFirst =
    toolOrder(withSkill.events)[0] === "read_skill" &&
    toolOrder(withSkill.events).indexOf("read_skill") <
      toolOrder(withSkill.events).indexOf("write_file");

  console.log("Dengan skill: urutan tool =", toolOrder(withSkill.events).join(" -> "));
  console.log("Tanpa skill:  urutan tool =", toolOrder(withoutSkill.events).join(" -> "));
  console.log("");
  console.log("Cek struktur index.html (sesuai skill website):");
  let pass = readFirst;
  for (const [label, check] of CHECKS) {
    const a = check(withSkill.html) ? "YA " : "TIDAK";
    const b = check(withoutSkill.html) ? "YA" : "tidak";
    if (!check(withSkill.html)) pass = false;
    console.log(`  ${label.padEnd(28)} dengan skill: ${a} | tanpa skill: ${b}`);
  }
  console.log("");
  console.log(
    pass && readFirst
      ? "SMOKE PASS: agent membaca read_skill(website) dulu, lalu hasilnya mengikuti skill."
      : "SMOKE FAIL: lihat baris di atas.",
  );
  if (!pass || !readFirst) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
