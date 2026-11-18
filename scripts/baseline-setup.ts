// Human baseline setup (Fase 8): `npm run baseline-setup` — writes the
// setup files of all 16 eval tasks into workspace/.bikinin/baseline/<id>/,
// one folder per task, so a human can do the baseline by hand. No LLM,
// no network, no .env needed. Run once, then work through the folders
// in order, timed, following docs/eval-baseline.md. Re-running the script
// resets every task folder to its fresh setup (your work is overwritten).
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { TASKS } from "../src/eval/tasks.js";

const slug = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 40);

async function main(): Promise<void> {
  const root = resolve("workspace", ".bikinin", "baseline");
  for (const task of TASKS) {
    const dir = join(root, slug(task.id));
    await mkdir(dir, { recursive: true });
    for (const [rel, content] of Object.entries(task.setup ?? {})) {
      const target = join(dir, rel);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    console.log(`${task.id} -> ${dir}`);
  }
  console.log(`\n${TASKS.length} task folders ready in ${root}`);
  console.log("Work through them in order, timed — see docs/eval-baseline.md.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
