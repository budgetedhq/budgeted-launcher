import type { OperationPhase, OperationStatus } from "../shared/contracts";

const terminal = new Set<OperationStatus>(["succeeded", "failed", "cancelled", "interrupted"]);

export function canTransition(from: OperationStatus, to: OperationStatus) {
  if (terminal.has(from)) return false;
  if (from === "queued") return ["running", "cancelling", "failed", "cancelled"].includes(to);
  if (from === "running") return ["cancelling", "succeeded", "failed", "cancelled", "interrupted"].includes(to);
  return ["cancelled", "failed", "interrupted"].includes(to);
}

export function statusForPhase(phase: OperationPhase): OperationStatus {
  if (phase === "queued") return "queued";
  if (phase === "complete") return "succeeded";
  if (phase === "failed") return "failed";
  if (phase === "cancelled") return "cancelled";
  if (phase === "interrupted") return "interrupted";
  return "running";
}
