// Context trimming (Fase 1): when a session's history approaches the char
// budget, the oldest runs are replaced by a short extractive summary instead
// of being dropped silently. Deterministic by design, and documented here:
//
// There is no cheap-model path in the codebase to call: BIKININ_CHEAP_MODEL
// exists only in .env.example and config.ts never reads it, so a model-based
// summary would need a second provider config, an extra paid LLM call per
// trim, and a new failure mode (a failed summary must not break the run).
// The extractive summary below is free, instant, and cannot fail — and it
// preserves exactly what the spec names: user requests, decisions and
// user-stated facts, and file outcomes. A model summary could phrase things
// nicer, but it could also invent details; this one only quotes what
// actually happened.
import type { ChatCompletionMessageParam as Msg } from "openai/resources/chat/completions";
import { extractFacts } from "./memory.js";

export const SUMMARY_MAX_CHARS = 4000;

function firstLines(text: string, maxChars: number): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const joined = lines.slice(0, 2).join(" ");
  return joined.length > maxChars
    ? `${joined.slice(0, maxChars)}…`
    : joined;
}

function toolArgs(msg: Msg): Record<string, unknown> | null {
  if (msg.role !== "assistant" || !msg.tool_calls) return null;
  for (const c of msg.tool_calls) {
    if (c.type !== "function") continue;
    try {
      const parsed: unknown = JSON.parse(c.function.arguments || "{}");
      if (typeof parsed === "object" && parsed !== null)
        return { name: c.function.name, args: parsed };
    } catch {
      // unparseable args: ignore this call
    }
  }
  return null;
}

/**
 * One compact summary of the given (oldest) runs. Keeps, per run: what the
 * user asked, which files were written/edited, the durable facts the run
 * taught (via the same rule-based extraction as long-term memory), and the
 * first line of the final answer.
 */
export function extractiveSummary(runs: Msg[][]): string {
  const out: string[] = [
    "Ringkasan obrolan sebelumnya (dibuat otomatis saat memangkas konteks — run lama sudah diganti ringkasan ini):",
  ];
  runs.forEach((run, i) => {
    const user = run.find(
      (m) => m.role === "user" && typeof m.content === "string",
    );
    const files = new Set<string>();
    const commands: string[] = [];
    for (const m of run) {
      const t = toolArgs(m);
      if (!t) continue;
      const args = t.args as Record<string, unknown>;
      if (
        (t.name === "write_file" || t.name === "edit_file") &&
        typeof args.path === "string"
      )
        files.add(args.path);
      if (t.name === "run_command" && typeof args.command === "string")
        commands.push(String(args.command).slice(0, 80));
    }
    const lastAssistant = [...run]
      .reverse()
      .find((m) => m.role === "assistant" && typeof m.content === "string");
    const facts = extractFacts(
      run,
      typeof lastAssistant?.content === "string" ? lastAssistant.content : "",
      [...files],
      [],
      "completed",
    ).filter((f) => f.kind !== "hasil");
    const parts: string[] = [];
    if (user && typeof user.content === "string")
      parts.push(`minta: ${firstLines(user.content, 200)}`);
    if (files.size > 0) parts.push(`file: ${[...files].slice(0, 6).join(", ")}`);
    if (commands.length > 0)
      parts.push(`perintah: ${commands.slice(0, 3).join(" | ")}`);
    for (const f of facts.slice(0, 3))
      parts.push(`${f.kind}: ${f.text.slice(0, 160)}`);
    if (lastAssistant && typeof lastAssistant.content === "string")
      parts.push(`hasil: ${firstLines(lastAssistant.content, 150)}`);
    if (parts.length > 0) out.push(`- Percakapan ${i + 1}: ${parts.join(" — ")}`);
  });
  const text = out.join("\n");
  return text.length > SUMMARY_MAX_CHARS
    ? `${text.slice(0, SUMMARY_MAX_CHARS)}…[ringkasan dipotong]`
    : text;
}
