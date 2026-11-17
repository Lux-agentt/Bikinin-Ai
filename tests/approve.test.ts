import { describe, expect, it, vi } from "vitest";
import { makeApprover } from "../src/approve.js";

describe("makeApprover", () => {
  it("auto-approves in yolo mode without asking", async () => {
    const ask = vi.fn(async () => false);
    const approve = makeApprover(true, ask);
    await expect(
      approve({
        approvalId: "a1",
        command: "npm install",
        reason: "di luar allowlist",
        risk: "medium",
      }),
    ).resolves.toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("delegates to the prompt when yolo is off", async () => {
    const ask = vi.fn(async () => false);
    const approve = makeApprover(false, ask);
    await expect(
      approve({
        approvalId: "a1",
        command: "npm install",
        reason: "di luar allowlist",
        risk: "medium",
      }),
    ).resolves.toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});
