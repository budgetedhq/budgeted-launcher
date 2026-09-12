import { cloudOperationSchema, operationRequestSchema, saveConfigurationRequestSchema } from "../src/shared/contracts";

describe("browser API contracts", () => {
  it("requires the current configuration revision on mutations", () => {
    expect(operationRequestSchema.safeParse({}).success).toBe(false);
    expect(saveConfigurationRequestSchema.safeParse({ configuration: {} }).success).toBe(false);
  });

  it("strips runner-only secret parameter metadata from browser operations", () => {
    const operation = cloudOperationSchema.parse({
      id: "977b1b90-cf3a-4a05-8979-c65b085b210e",
      action: "prepare",
      inputRevision: 1,
      fingerprint: "a".repeat(64),
      phase: "queued",
      status: "queued",
      createdAt: new Date().toISOString(),
      expiresAt: Math.floor(Date.now() / 1_000) + 60,
      remoteStateUncertain: false,
      secretParameterNames: { plaidSecret: "/hidden" },
    });
    expect(operation).not.toHaveProperty("secretParameterNames");
  });
});
