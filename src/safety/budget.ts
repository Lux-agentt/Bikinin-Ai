// Cost budget (28 Nov 2026: the step limit was removed at the owner's
// request — runs stop only on cost now, or when the user presses Stop).
// Emits 80% and 100% cost alerts exactly once each.
export interface BudgetAlert {
  kind: "cost";
  used: number;
  limit: number;
  percent: 80 | 100;
}

export class Budget {
  steps = 0;
  costUsd = 0;
  private readonly fired = new Set<string>();

  /**
   * maxSteps is optional: the main run has NO step limit (removed 28 Nov
   * 2026 at the owner's request) and passes nothing here; subagents still
   * pass their own cap (SUBAGENT_MAX_STEPS) so a runaway subagent stops.
   */
  constructor(
    readonly maxCostUsd: number,
    readonly maxSteps?: number,
  ) {}

  addCost(usd: number): void {
    this.costUsd += usd;
  }

  stepsExceeded(): boolean {
    return this.maxSteps !== undefined && this.steps >= this.maxSteps;
  }

  costExceeded(): boolean {
    return this.costUsd >= this.maxCostUsd;
  }

  takeAlerts(): BudgetAlert[] {
    const alerts: BudgetAlert[] = [];
    const c = { kind: "cost" as const, used: this.costUsd, limit: this.maxCostUsd };
    const pct = c.limit > 0 ? (c.used / c.limit) * 100 : 100;
    for (const percent of [80, 100] as const) {
      const key = `${c.kind}:${percent}`;
      if (pct >= percent && !this.fired.has(key)) {
        this.fired.add(key);
        alerts.push({ ...c, percent });
      }
    }
    return alerts;
  }
}
