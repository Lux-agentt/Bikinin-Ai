// Approval callback factory for the CLI (Fase 1).
// --yolo auto-approves every "confirm" command — but only because the owner
// passed the flag explicitly on this invocation. It never bypasses a "block"
// verdict: that check lives in the loop/tool layer before approve() is ever
// called, so rm -rf /, sudo, git, and friends stay blocked even in yolo mode.
import type { ApprovalRequest } from "./agent/loop.js";

export function makeApprover(
  yolo: boolean,
  ask: (req: ApprovalRequest) => Promise<boolean>,
): (req: ApprovalRequest) => Promise<boolean> {
  return (req) => (yolo ? Promise.resolve(true) : ask(req));
}
