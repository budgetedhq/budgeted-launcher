import {
  BatchGetCommand, DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { z } from "zod";

import { createConfigurationDocument, parseBudgetedToml } from "../core/configuration";
import {
  DEFAULT_CONFIGURATION, cloudOperationSchema, initialAdminSchema, launcherSettingsV2Schema,
  type BudgetedConfiguration, type CloudOperation, type InitialAdmin, type LauncherSettingsV2,
} from "../shared/contracts";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const STATE_KEY = "STATE";
const operationKey = (id: string) => `OPERATION#${id}`;
const idempotencyKey = (key: string) => `IDEMPOTENCY#${key}`;

export type StateIdentity = {
  ownerEmail: string;
  awsAccountId: string;
  awsRegion: LauncherSettingsV2["awsRegion"];
  launcherVersion: string;
};

export type RunnerJob = CloudOperation & {
  pk: string;
  initialAdmin?: InitialAdmin;
  secretParameterNames?: Record<string, string>;
};
const runnerJobSchema = cloudOperationSchema.extend({
  pk: z.string(),
  initialAdmin: initialAdminSchema.optional(),
  secretParameterNames: z.record(z.string(), z.string().startsWith("/")).optional(),
});

export class StateStore {
  constructor(private readonly tableName: string) {}

  async getOrCreateState(identity: StateIdentity): Promise<LauncherSettingsV2> {
    const existing = await client.send(new GetCommand({ TableName: this.tableName, Key: { pk: STATE_KEY }, ConsistentRead: true }));
    if (existing.Item) return launcherSettingsV2Schema.parse(existing.Item);
    const now = new Date().toISOString();
    const state = launcherSettingsV2Schema.parse({
      pk: STATE_KEY,
      schemaVersion: 2,
      repository: "budgetedhq/budgeted",
      ...identity,
      configuration: createConfigurationDocument(DEFAULT_CONFIGURATION),
      latestOperationIds: [],
      updatedAt: now,
    });
    try {
      await client.send(new PutCommand({ TableName: this.tableName, Item: { pk: STATE_KEY, ...state }, ConditionExpression: "attribute_not_exists(pk)" }));
      return state;
    } catch (error) {
      if (!isConditionalError(error)) throw error;
      return this.getState();
    }
  }

  async getState(): Promise<LauncherSettingsV2> {
    const result = await client.send(new GetCommand({ TableName: this.tableName, Key: { pk: STATE_KEY }, ConsistentRead: true }));
    if (!result.Item) throw new Error("Launcher state has not been initialized.");
    return launcherSettingsV2Schema.parse(result.Item);
  }

  async saveStructured(expectedRevision: number, configuration: BudgetedConfiguration, initialAdmin?: InitialAdmin) {
    const current = await this.getState();
    this.assertWritable(current, expectedRevision);
    const next = createConfigurationDocument(configuration, expectedRevision + 1);
    await this.updateConfiguration(expectedRevision, next, initialAdmin);
    return this.getState();
  }

  async saveToml(expectedRevision: number, toml: string) {
    const current = await this.getState();
    this.assertWritable(current, expectedRevision);
    const structured = parseBudgetedToml(toml, current.configuration.structured);
    const next = { structured, toml, source: "toml" as const, revision: expectedRevision + 1, updatedAt: new Date().toISOString() };
    await this.updateConfiguration(expectedRevision, next, current.initialAdmin);
    return this.getState();
  }

  async getOperation(id: string): Promise<CloudOperation | undefined> {
    const result = await client.send(new GetCommand({ TableName: this.tableName, Key: { pk: operationKey(id) }, ConsistentRead: true }));
    return result.Item ? cloudOperationSchema.parse(result.Item) : undefined;
  }

  async getRunnerJob(id: string): Promise<RunnerJob | undefined> {
    const result = await client.send(new GetCommand({ TableName: this.tableName, Key: { pk: operationKey(id) }, ConsistentRead: true }));
    return result.Item ? runnerJobSchema.parse(result.Item) : undefined;
  }

  async getOperations(ids: string[]) {
    if (!ids.length) return [];
    const result = await client.send(new BatchGetCommand({ RequestItems: { [this.tableName]: { Keys: ids.map((id) => ({ pk: operationKey(id) })) } } }));
    const values = (result.Responses?.[this.tableName] ?? []).map((item) => cloudOperationSchema.parse(item));
    return ids.flatMap((id) => values.find((item) => item.id === id) ?? []);
  }

  async startOperation(input: {
    operation: CloudOperation;
    expectedRevision: number;
    idempotencyKey: string;
    initialAdmin?: InitialAdmin;
    secretParameterNames?: Record<string, string>;
  }) {
    const idempotency = await client.send(new GetCommand({ TableName: this.tableName, Key: { pk: idempotencyKey(input.idempotencyKey) }, ConsistentRead: true }));
    if (idempotency.Item) {
      if (idempotency.Item.action !== input.operation.action) throw new ConflictError("IDEMPOTENCY_KEY_REUSED", "The idempotency key was already used for a different action.");
      const existing = await this.getOperation(String(idempotency.Item.operationId));
      if (existing) return existing;
    }
    const recentIds = [input.operation.id, ...(await this.getState()).latestOperationIds].slice(0, 20);
    try {
      await client.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: { TableName: this.tableName, Key: { pk: STATE_KEY }, ConditionExpression: "configuration.revision = :revision AND attribute_not_exists(activeOperationId)", ExpressionAttributeValues: { ":revision": input.expectedRevision } } },
        { Put: { TableName: this.tableName, Item: { pk: operationKey(input.operation.id), ...input.operation, initialAdmin: input.initialAdmin, secretParameterNames: input.secretParameterNames }, ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: this.tableName, Item: { pk: idempotencyKey(input.idempotencyKey), operationId: input.operation.id, action: input.operation.action, expiresAt: input.operation.expiresAt }, ConditionExpression: "attribute_not_exists(pk)" } },
        { Update: { TableName: this.tableName, Key: { pk: STATE_KEY }, UpdateExpression: "SET activeOperationId = :id, latestOperationIds = :ids, updatedAt = :now", ExpressionAttributeValues: { ":id": input.operation.id, ":ids": recentIds, ":now": new Date().toISOString() } } },
      ] }));
      return input.operation;
    } catch (error) {
      if (!isTransactionConflict(error)) throw error;
      const current = await this.getState();
      if (current.configuration.revision !== input.expectedRevision) throw new ConflictError("STALE_CONFIGURATION", "The configuration changed. Refresh and try again.");
      throw new ConflictError("OPERATION_ACTIVE", "Another launcher operation is already active.");
    }
  }

  async attachBuild(id: string, codeBuildId: string, logStreamName?: string) {
    await this.updateOperation(id, `SET codeBuildId = :build, #status = :status, phase = :phase, startedAt = :now${logStreamName ? ", logStreamName = :stream" : ""}`, {
      ":build": codeBuildId, ":status": "running", ":phase": "downloading", ":now": new Date().toISOString(), ...(logStreamName ? { ":stream": logStreamName } : {}),
    });
  }

  async updateOperation(id: string, updateExpression: string, values: Record<string, unknown>, names?: Record<string, string>) {
    const expressionNames = { ...(updateExpression.includes("#status") ? { "#status": "status" } : {}), ...names };
    await client.send(new UpdateCommand({
      TableName: this.tableName, Key: { pk: operationKey(id) }, UpdateExpression: updateExpression,
      ExpressionAttributeValues: values, ...(Object.keys(expressionNames).length ? { ExpressionAttributeNames: expressionNames } : {}), ConditionExpression: "attribute_exists(pk)",
    }));
  }

  async completeOperation(id: string, status: "succeeded" | "failed" | "cancelled" | "interrupted", error?: string) {
    const operation = await this.getOperation(id);
    if (!operation) return;
    const uncertain = status === "interrupted" && ["deploy", "redeploy", "rollback", "remove"].includes(operation.action);
    const now = new Date().toISOString();
    const errorUpdate = error ? ", #error = :error" : "";
    await this.updateOperation(id, `SET #status = :status, phase = :phase, finishedAt = :now, remoteStateUncertain = :uncertain${errorUpdate}${error ? "" : " REMOVE #error"}`, {
      ":status": status, ":phase": status === "succeeded" ? "complete" : status === "cancelled" ? "cancelled" : status === "interrupted" ? "interrupted" : "failed",
      ":now": now, ":uncertain": uncertain, ...(error ? { ":error": error } : {}),
    }, { "#error": "error" });
    const update = uncertain
      ? "SET uncertainRemoteState = :uncertain, updatedAt = :now REMOVE activeOperationId"
      : "SET updatedAt = :now REMOVE activeOperationId";
    await client.send(new UpdateCommand({ TableName: this.tableName, Key: { pk: STATE_KEY }, UpdateExpression: update, ConditionExpression: "activeOperationId = :id", ExpressionAttributeValues: { ":id": id, ":now": now, ...(uncertain ? { ":uncertain": { action: operation.action, operationId: id, markedAt: now } } : {}) } }));
  }

  async mutateState(updateExpression: string, values: Record<string, unknown>, names?: Record<string, string>) {
    await client.send(new UpdateCommand({ TableName: this.tableName, Key: { pk: STATE_KEY }, UpdateExpression: updateExpression, ExpressionAttributeValues: values, ExpressionAttributeNames: names }));
  }

  private assertWritable(current: LauncherSettingsV2, expectedRevision: number) {
    if (current.configuration.revision !== expectedRevision) throw new ConflictError("STALE_CONFIGURATION", "The configuration changed. Refresh and try again.");
    if (current.activeOperationId) throw new ConflictError("OPERATION_ACTIVE", "Configuration cannot change while an operation is active.");
  }

  private async updateConfiguration(expectedRevision: number, configuration: LauncherSettingsV2["configuration"], initialAdmin?: InitialAdmin) {
    try {
      const hasAdmin = Boolean(initialAdmin);
      await client.send(new UpdateCommand({
        TableName: this.tableName, Key: { pk: STATE_KEY },
        UpdateExpression: `SET configuration = :configuration, updatedAt = :now${hasAdmin ? ", initialAdmin = :admin" : ""} REMOVE pendingDeployment${hasAdmin ? "" : ", initialAdmin"}`,
        ConditionExpression: "configuration.revision = :revision AND attribute_not_exists(activeOperationId)",
        ExpressionAttributeValues: { ":configuration": configuration, ...(hasAdmin ? { ":admin": initialAdmin } : {}), ":now": new Date().toISOString(), ":revision": expectedRevision },
      }));
    } catch (error) {
      if (isConditionalError(error)) throw new ConflictError("STALE_CONFIGURATION", "The configuration changed or an operation started. Refresh and try again.");
      throw error;
    }
  }
}

export class ConflictError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function isConditionalError(error: unknown) {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

function isTransactionConflict(error: unknown) {
  return error instanceof Error && ["TransactionCanceledException", "ConditionalCheckFailedException"].includes(error.name);
}
