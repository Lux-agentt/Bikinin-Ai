// The only list of tools the agent can call. read_skill (Fase 2) is here;
// preview/render_video come later.
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { editFileTool } from "./edit-file.js";
import { listDirTool } from "./list-dir.js";
import { readFileTool } from "./read-file.js";
import { readSkillTool } from "./read-skill.js";
import { runCommandTool } from "./run-command.js";
import type { RegisteredTool } from "./types.js";
import { writeFileTool } from "./write-file.js";

export const TOOLS: RegisteredTool[] = [
  listDirTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  runCommandTool,
  readSkillTool,
];

export function getTool(name: string): RegisteredTool | undefined {
  return TOOLS.find((t) => t.name === name);
}

export function toolSpecsForLlm(): ChatCompletionTool[] {
  return TOOLS.map((t): ChatCompletionTool => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
