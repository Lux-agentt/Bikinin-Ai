// Reads configuration from .env / process.env. Never logs values.
import { config as loadDotenv } from "dotenv";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { resolveProviders, type ProviderConfig } from "./llm/providers.js";

const LimitsSchema = z.object({
  BIKININ_USD_IDR: z.coerce.number().positive().default(17000),
  BIKININ_MAX_COST_USD: z.coerce.number().positive().default(0.5),
  BIKININ_WORKSPACE: z
    .string()
    .min(1)
    .default(join(homedir(), "bikinin-workspace")),
  BIKININ_MAX_VIDEO_SECONDS: z.coerce.number().int().positive().default(30),
  // Model router (Fase 7): on by default; off/false/0 disables it.
  // Optional so older hand-built Config literals still compile.
  BIKININ_ROUTER: z.string().optional(),
  // Model-assisted memory extraction (Fase 8): OFF by default. Only
  // on/true/1 enable it; see isMemoryModelExtractEnabled below.
  // Optional so older hand-built Config literals still compile.
  BIKININ_MEMORY_MODEL_EXTRACT: z.string().optional(),
  // Auto-approve low/medium-risk approvals (28 Nov 2026, owner rule:
  // "otomatis allow aja, kecuali yang high impact"). OFF by default; only
  // on/true/1 enable it. High-risk approvals still ask; hard blocks
  // (rm root, sudo, .env, git/gh/ssh, curl|sh, ...) still block.
  BIKININ_AUTO_APPROVE: z.string().optional(),
});

/** BIKININ_AUTO_APPROVE is OFF by default; only on/true/1 turn it on. */
export function isAutoApproveEnabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["on", "true", "1"].includes(value.trim().toLowerCase());
}

/** BIKININ_MEMORY_MODEL_EXTRACT is OFF by default; only on/true/1 turn it on. */
export function isMemoryModelExtractEnabled(
  value: string | undefined,
): boolean {
  if (value === undefined) return false;
  return ["on", "true", "1"].includes(value.trim().toLowerCase());
}

export interface Config extends z.infer<typeof LimitsSchema> {
  providers: ProviderConfig[];
}

export function loadConfig(): Config {
  loadDotenv({ quiet: true });
  const limits = LimitsSchema.safeParse(process.env);
  if (!limits.success) {
    const lines = limits.error.issues.map(
      (i) => `  - ${i.path.join(".")}: ${i.message}`,
    );
    throw new Error(`Konfigurasi .env tidak valid:\n${lines.join("\n")}`);
  }
  return { ...limits.data, providers: resolveProviders(process.env) };
}
