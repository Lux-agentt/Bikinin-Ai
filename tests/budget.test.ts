import { describe, expect, it } from "vitest";
import { Budget } from "../src/safety/budget.js";
import { costUsd } from "../src/llm/pricing.js";

describe("Budget", () => {
  it("fires 80% and 100% cost alerts exactly once each", () => {
    // 28 Nov 2026: the step limit was removed — Budget is cost-only now.
    const b = new Budget(1);
    b.addCost(0.8);
    expect(b.takeAlerts().map((a) => a.percent)).toEqual([80]);
    expect(b.takeAlerts()).toEqual([]);
    b.addCost(0.2);
    expect(b.takeAlerts().map((a) => a.percent)).toEqual([100]);
    expect(b.costExceeded()).toBe(true);
  });

  it("tracks cost limit", () => {
    const b = new Budget(0.5);
    b.addCost(0.3);
    expect(b.costExceeded()).toBe(false);
    b.addCost(0.25);
    expect(b.costExceeded()).toBe(true);
  });
});

describe("costUsd", () => {
  it("computes cost from usage and env prices", () => {
    expect(
      costUsd(
        { input_tokens: 1_000_000, output_tokens: 500_000 },
        { inPerM: 0.5, outPerM: 2 },
      ),
    ).toBeCloseTo(1.5);
  });
});
