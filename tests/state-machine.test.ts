import { canTransition, statusForPhase } from "../src/core/state-machine";
import { versionInRange } from "../src/core/supported-version";

describe("cloud operation state machine", () => {
  it("allows running operations to finish but terminal operations never restart", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "interrupted")).toBe(true);
    expect(canTransition("succeeded", "running")).toBe(false);
  });

  it("enforces the signed Budgeted compatibility range", () => {
    expect(versionInRange("0.1.2", ">=0.1.0 <1.0.0")).toBe(true);
    expect(versionInRange("1.0.0", ">=0.1.0 <1.0.0")).toBe(false);
  });

  it("maps phases to durable statuses", () => {
    expect(statusForPhase("diffing")).toBe("running");
    expect(statusForPhase("complete")).toBe("succeeded");
  });
});
