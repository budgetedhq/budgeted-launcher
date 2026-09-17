import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import { createConfigurationDocument } from "../src/core/configuration";
import { StateStore } from "../src/cloud/store";
import { DEFAULT_CONFIGURATION, type CloudOperation } from "../src/shared/contracts";

const send = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/lib-dynamodb", async (importOriginal) => {
  const original = await importOriginal<typeof import("@aws-sdk/lib-dynamodb")>();
  return {
    ...original,
    DynamoDBDocumentClient: { from: () => ({ send }) },
  };
});

describe("state store operations", () => {
  it("touches each item only once when starting an operation", async () => {
    const now = new Date().toISOString();
    const operation: CloudOperation = {
      id: "977b1b90-cf3a-4a05-8979-c65b085b210e",
      action: "prepare",
      inputRevision: 0,
      fingerprint: "a".repeat(64),
      phase: "queued",
      status: "queued",
      createdAt: now,
      expiresAt: Math.floor(Date.now() / 1_000) + 60,
      remoteStateUncertain: false,
    };
    send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: {
        pk: "STATE",
        schemaVersion: 2,
        repository: "budgetedhq/budgeted",
        ownerEmail: "owner@example.com",
        awsAccountId: "123456789012",
        awsRegion: "us-east-1",
        launcherVersion: "test",
        configuration: createConfigurationDocument(DEFAULT_CONFIGURATION),
        latestOperationIds: [],
        updatedAt: now,
      } })
      .mockResolvedValueOnce({});

    await new StateStore("launcher-state").startOperation({
      operation,
      expectedRevision: 0,
      idempotencyKey: "request-key",
    });

    const command = send.mock.calls[2]?.[0];
    expect(command).toBeInstanceOf(TransactWriteCommand);
    const items = (command as TransactWriteCommand).input.TransactItems ?? [];
    const keys = items.map((item) => item.Put?.Item?.pk ?? item.Update?.Key?.pk ?? item.Delete?.Key?.pk ?? item.ConditionCheck?.Key?.pk);
    expect(keys).toEqual([
      `OPERATION#${operation.id}`,
      "IDEMPOTENCY#request-key",
      "STATE",
    ]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(items[2]?.Update?.ConditionExpression).toBe("configuration.revision = :revision AND attribute_not_exists(activeOperationId)");
  });
});
