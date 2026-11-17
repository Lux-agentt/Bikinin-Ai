// Tool contract: zod validates args, errors go back to the model as results (never crash the loop).
import type { z } from "zod";
import type { VisionRequest, VisionResult } from "../llm/client.js";
import { ToolName as ToolNameSchema } from "../events.js";
import type { Verdict } from "../safety/commands.js";

export type ToolName = z.infer<typeof ToolNameSchema>;

export const OUTPUT_LIMIT = 8000;

export function truncate(
  text: string,
  limit = OUTPUT_LIMIT,
): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return {
    text: `${text.slice(0, limit)}\n...[dipotong: ${text.length - limit} karakter lagi]`,
    truncated: true,
  };
}

export interface FileChange {
  path: string; // relative to workspace
  op: "created" | "modified" | "deleted";
  bytes: number;
  /** Unified diff of the change (loop-filled, truncated ~2000 chars). */
  diff?: string;
}

export interface ToolResult {
  ok: boolean;
  summary: string;
  output: string;
  changes: FileChange[];
  /** Token usage of a tool's own model call (vision via inspect_image).
   *  The loop adds it to the run totals and emits a `usage` event. */
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
  };
}

export interface ToolContext {
  workspace: string; // absolute, realpath
  /** Subagent runner (Fase 5). Only the `delegate` tool uses it; absent in runs without one. */
  delegate?: (
    task: string,
    context?: string,
  ) => Promise<{
    summary: string;
    status: string;
    steps: number;
    costUsd: number;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cached_tokens: number;
    };
  }>;
  /**
   * Vision, wired by the loop from the fallback LLM client. A tool must never
   * build its own LLM client. Absent when the run has no vision wired in.
   */
  describeImage?: (req: VisionRequest) => Promise<VisionResult>;
}

export interface ToolSpec<S extends z.ZodTypeAny> {
  name: ToolName;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema for the model
  readOnly: boolean;
  schema: S;
  label: (args: z.output<S>) => string;
  publicArgs: (args: z.output<S>) => Record<string, unknown>; // safe to show in events
  gate?: (args: z.output<S>) => Verdict;
  run: (args: z.output<S>, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ParsedOk {
  ok: true;
  label: string;
  publicArgs: Record<string, unknown>;
  gate: Verdict;
  execute: (ctx: ToolContext) => Promise<ToolResult>;
}

export type ParseResult = ParsedOk | { ok: false; error: string };

export interface RegisteredTool {
  name: ToolName;
  description: string;
  parameters: Record<string, unknown>;
  readOnly: boolean;
  parse: (raw: unknown) => ParseResult;
}

export function defineTool<S extends z.ZodTypeAny>(
  spec: ToolSpec<S>,
): RegisteredTool {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    readOnly: spec.readOnly,
    parse(raw) {
      const parsed = spec.schema.safeParse(raw);
      if (!parsed.success) {
        const error = parsed.error.issues
          .map((i) => `${i.path.join(".") || "args"}: ${i.message}`)
          .join("; ");
        return { ok: false, error };
      }
      const args: z.output<S> = parsed.data;
      return {
        ok: true,
        label: spec.label(args),
        publicArgs: spec.publicArgs(args),
        gate: spec.gate?.(args) ?? { decision: "allow" },
        execute: (ctx) => spec.run(args, ctx),
      };
    },
  };
}
