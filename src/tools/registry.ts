// The only list of tools the agent can call. read_skill (Fase 2),
// render_video (Fase 3), and web_search / update_plan / delegate (Fase 5)
// are here; preview comes later.
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { delegateTool } from "./delegate.js";
import { editFileTool } from "./edit-file.js";
import { gitTool } from "./git.js";
import { inspectImageTool } from "./inspect-image.js";
import { installSkillTool } from "./install-skill.js";
import { listDirTool } from "./list-dir.js";
import { mcpCallTool } from "./mcp-call.js";
import { readFileTool } from "./read-file.js";
import { readSkillTool } from "./read-skill.js";
import { renderVideoTool } from "./render-video.js";
import { requestPlanApprovalTool } from "./request-plan-approval.js";
import { runCommandTool } from "./run-command.js";
import type { RegisteredTool } from "./types.js";
import { updatePlanTool } from "./update-plan.js";
import { webSearchTool } from "./web-search.js";
import { writeFileTool } from "./write-file.js";

export const TOOLS: RegisteredTool[] = [
  listDirTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  runCommandTool,
  readSkillTool,
  renderVideoTool,
  webSearchTool,
  updatePlanTool,
  delegateTool,
  inspectImageTool,
  gitTool,
  mcpCallTool,
  requestPlanApprovalTool,
  installSkillTool,
];

export function getTool(name: string): RegisteredTool | undefined {
  return TOOLS.find((t) => t.name === name);
}

export function toolSpecsForLlm(
  tools: RegisteredTool[] = TOOLS,
): ChatCompletionTool[] {
  return tools.map((t): ChatCompletionTool => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
