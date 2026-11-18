// Rebuilds a session's conversation history from its .jsonl event log
// (Fase 1 --continue). Pure logic, no filesystem here, so it is easy to test.
//
// KNOWN LIMIT (Gemini): rebuilt tool-call turns carry no thought
// signature — events never store it (opaque provider token, kept out of
// logs by design) — so a continued Gemini run 400s on its first replayed
// tool turn. Fresh runs are unaffected: the live loop echoes signatures
// from the response itself (see echoToolCalls in src/llm/client.ts).
//
// Mapping (one run = one transcript, grouped by run_id in file order):
// - run_started.user_message -> the run's user turn
// - text_delta chunks -> accumulated into one assistant text turn
// - tool_call_started -> an assistant turn carrying that tool call
//   (args come from the event's redacted public args)
// - tool_call_finished.output_preview -> the matching tool turn
// - run_finished -> flushes any remaining streamed text as an assistant turn
// - everything else (approvals, usage, file_changed, errors, ...) is skipped:
//   it has no place in the model transcript.
// A tool call whose result never arrived is dropped by compactRun inside
// SessionHistory.add, so the rebuilt history is always API-valid.
import type { ChatCompletionMessageParam as Msg } from "openai/resources/chat/completions";
import type { AgentEvent } from "../events.js";
import { SessionHistory } from "./history.js";

interface PendingCall {
  name: string;
  args: string;
}

export function rebuildHistory(events: AgentEvent[]): SessionHistory {
  const history = new SessionHistory();
  // Group events by run, keeping first-seen order.
  const runs: Array<{ runId: string; events: AgentEvent[] }> = [];
  const byId = new Map<string, (typeof runs)[number]>();
  for (const e of events) {
    let run = byId.get(e.run_id);
    if (!run) {
      run = { runId: e.run_id, events: [] };
      byId.set(e.run_id, run);
      runs.push(run);
    }
    run.events.push(e);
  }

  for (const run of runs) {
    const transcript: Msg[] = [];
    let textBuffer = "";
    const calls = new Map<string, PendingCall>();
    const flushText = () => {
      if (textBuffer.trim()) {
        transcript.push({ role: "assistant", content: textBuffer });
      }
      textBuffer = "";
    };
    for (const e of run.events) {
      switch (e.type) {
        case "run_started":
          transcript.push({ role: "user", content: e.user_message });
          break;
        case "text_delta":
          textBuffer += e.text;
          break;
        case "tool_call_started":
          flushText();
          calls.set(e.call_id, {
            name: e.tool,
            args: JSON.stringify(e.args ?? {}),
          });
          transcript.push({
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: e.call_id,
                type: "function",
                function: { name: e.tool, arguments: JSON.stringify(e.args ?? {}) },
              },
            ],
          });
          break;
        case "tool_call_finished": {
          const call = calls.get(e.call_id);
          if (!call) break; // result without a start: ignore
          transcript.push({
            role: "tool",
            tool_call_id: e.call_id,
            content: e.output_preview ?? "",
          });
          break;
        }
        case "run_finished":
          // Normally the final text already arrived via text_delta and the
          // buffer holds it. If nothing was streamed (e.g. an error run),
          // keep the summary so the failure is not forgotten.
          {
            const hadText = textBuffer.trim().length > 0;
            flushText();
            if (!hadText && e.summary.trim())
              transcript.push({ role: "assistant", content: e.summary });
          }
          break;
        default:
          break;
      }
    }
    flushText();
    if (transcript.length > 0) history.add(transcript);
  }
  return history;
}
