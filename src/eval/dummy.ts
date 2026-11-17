// Scripted dummy LLM for eval (Fase 7): zero cost, no API key, no network.
// Plays back a task's `dummyScript` responses in order, then answers with a
// short honest fallback if the script runs out. Dummy mode verifies the
// eval HARNESS (scoring, logging, reporting); its scores say nothing about
// a real model's capability — see the header of tasks.ts.
import type { ChatResult, LlmClient } from "../llm/client.js";

export function createDummyLlm(script: ChatResult[]): LlmClient {
  let i = 0;
  return {
    async chat(p) {
      const r =
        script[i++] ??
        ({
          text: "Saya tidak tahu langkah berikutnya, jadi saya berhenti di sini.",
          toolCalls: [],
          usage: { input_tokens: 100, output_tokens: 20, cached_tokens: 0 },
        } satisfies ChatResult);
      if (r.text) p.onText?.(r.text);
      return r;
    },
  };
}
