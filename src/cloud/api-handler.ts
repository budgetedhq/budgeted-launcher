import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { z, ZodError } from "zod";
import { GetLogEventsCommand, CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { BatchGetBuildsCommand, CodeBuildClient } from "@aws-sdk/client-codebuild";

import {
  launcherUpdateRequestSchema, releaseCheckRequestSchema, releaseMetadataSchema, saveConfigurationRequestSchema,
  saveTomlRequestSchema, type ApiError, type LauncherSnapshot, type ReleaseMetadata,
} from "../shared/contracts";
import { versionInRange } from "../core/supported-version";
import { getEnvironment } from "./environment";
import { assertOwnerClaims } from "./authorization";
import { LauncherReleaseService } from "./launcher-releases";
import { OperationService } from "./operations";
import { ConflictError, StateStore } from "./store";

const env = getEnvironment();
const store = new StateStore(env.tableName);
const operations = new OperationService(store, { projectName: env.buildProjectName, parameterPrefix: env.operationParameterPrefix, logGroupName: env.operationLogGroup });
const launcherReleases = new LauncherReleaseService({
  bucket: env.publisherBucket, manifestKey: env.manifestKey, installedManifestKey: env.installedManifestKey, publicKey: env.manifestPublicKey,
  stackName: env.stackName, region: env.awsRegion, roleArn: env.selfUpdateRoleArn,
});
const logs = new CloudWatchLogsClient({});
const codeBuild = new CodeBuildClient({});

type ApiEvent = APIGatewayProxyEventV2WithJWTAuthorizer;

export async function handler(event: ApiEvent): Promise<APIGatewayProxyResultV2> {
  const requestId = event.requestContext.requestId;
  try {
    authorizeOwner(event);
    await store.getOrCreateState({ ownerEmail: env.ownerEmail, awsAccountId: env.awsAccountId, awsRegion: env.awsRegion, launcherVersion: env.launcherVersion });
    const method = event.requestContext.http.method;
    const path = event.rawPath;

    if (method === "GET" && path === "/api/v1/snapshot") return ok(await snapshot());
    if (method === "PUT" && path === "/api/v1/configuration") {
      requireIdempotencyKey(event);
      const body = saveConfigurationRequestSchema.parse(readBody(event));
      return ok(await store.saveStructured(body.configurationRevision, body.configuration, body.initialAdmin));
    }
    if (method === "GET" && path === "/api/v1/configuration/toml") {
      const state = await store.getState();
      return ok({ toml: state.configuration.toml, source: state.configuration.source, configurationRevision: state.configuration.revision });
    }
    if (method === "PUT" && path === "/api/v1/configuration/toml") {
      requireIdempotencyKey(event);
      const body = saveTomlRequestSchema.parse(readBody(event));
      return ok(await store.saveToml(body.configurationRevision, body.toml));
    }
    if (method === "POST" && path === "/api/v1/releases/check") {
      requireIdempotencyKey(event);
      const body = releaseCheckRequestSchema.parse(readBody(event));
      assertRevision(await store.getState(), body.configurationRevision);
      const state = await store.getState();
      const launcherRelease = await launcherReleases.installed();
      const release = await checkBudgetedRelease(launcherRelease.supportedBudgetedRange);
      const releaseChanged = state.selectedRelease?.commitSha !== release.commitSha;
      await store.mutateState(`SET selectedRelease = :release, lastReleaseCheckAt = :now, updatedAt = :now${releaseChanged ? " REMOVE pendingDeployment" : ""}`, { ":release": release, ":now": new Date().toISOString() });
      return ok(release);
    }
    const startMatch = /^\/api\/v1\/operations\/(prepare|diff|deploy|redeploy|rollback|unlock|seed|remove|verify)$/.exec(path);
    if (method === "POST" && startMatch) {
      const operation = await operations.start(startMatch[1] as Parameters<OperationService["start"]>[0], readBody(event), requireIdempotencyKey(event));
      return ok(operation, 202);
    }
    const operationMatch = /^\/api\/v1\/operations\/([0-9a-f-]+)$/.exec(path);
    if (method === "GET" && operationMatch) {
      const operation = await store.getOperation(operationMatch[1]);
      if (!operation) return failure(404, { code: "NOT_FOUND", message: "Operation not found.", requestId });
      return ok(operation);
    }
    const logsMatch = /^\/api\/v1\/operations\/([0-9a-f-]+)\/logs$/.exec(path);
    if (method === "GET" && logsMatch) return ok(await operationLogs(logsMatch[1], event.queryStringParameters?.cursor));
    const cancelMatch = /^\/api\/v1\/operations\/([0-9a-f-]+)\/cancel$/.exec(path);
    if (method === "POST" && cancelMatch) {
      requireIdempotencyKey(event);
      const body = z.object({ configurationRevision: z.number().int().nonnegative() }).parse(readBody(event));
      return ok(await operations.cancel(cancelMatch[1], body.configurationRevision), 202);
    }
    if (method === "GET" && path === "/api/v1/launcher/releases") return ok(await launcherReleases.current());
    if (method === "POST" && path === "/api/v1/launcher/update") {
      requireIdempotencyKey(event);
      const body = launcherUpdateRequestSchema.parse(readBody(event));
      const state = await store.getState();
      assertRevision(state, body.configurationRevision);
      if (state.activeOperationId) throw new ConflictError("OPERATION_ACTIVE", "Launcher updates cannot start while an operation is active.");
      return ok(await launcherReleases.update(body.version), 202);
    }
    return failure(404, { code: "NOT_FOUND", message: "Route not found.", requestId });
  } catch (error) {
    console.error(JSON.stringify({ requestId, error: safeError(error) }));
    if (error instanceof ConflictError) return failure(409, { code: error.code, message: error.message, requestId });
    if (error instanceof ZodError) {
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of error.issues) (fieldErrors[issue.path.join(".") || "request"] ??= []).push(issue.message);
      return failure(400, { code: "INVALID_REQUEST", message: "The request is invalid.", fieldErrors, requestId });
    }
    const status = error instanceof UnauthorizedError ? 403 : 500;
    return failure(status, { code: status === 403 ? "OWNER_REQUIRED" : "INTERNAL_ERROR", message: error instanceof UnauthorizedError ? error.message : "The launcher could not complete the request.", requestId });
  }
}

async function snapshot(): Promise<LauncherSnapshot> {
  const settings = await store.getState();
  const latestOperations = await store.getOperations(settings.latestOperationIds);
  return { settings, latestOperations, activeOperation: settings.activeOperationId ? latestOperations.find((operation) => operation.id === settings.activeOperationId) : undefined };
}

function authorizeOwner(event: ApiEvent) {
  const claims = event.requestContext.authorizer?.jwt?.claims;
  try { assertOwnerClaims(claims, env.ownerEmail); }
  catch { throw new UnauthorizedError("Only the verified launcher owner may use this application."); }
}

function readBody(event: ApiEvent) {
  if (!event.body) return {};
  const value = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try { return JSON.parse(value) as unknown; }
  catch { throw new ZodError([{ code: "custom", path: ["body"], message: "The request body must be valid JSON.", input: value }]); }
}

function requireIdempotencyKey(event: ApiEvent) {
  const value = event.headers["idempotency-key"];
  if (!value || value.length < 16 || value.length > 128) throw new ZodError([{ code: "custom", path: ["Idempotency-Key"], message: "A 16-128 character Idempotency-Key header is required.", input: value }]);
  return value;
}

function assertRevision(state: Awaited<ReturnType<StateStore["getState"]>>, revision: number) {
  if (state.configuration.revision !== revision) throw new ConflictError("STALE_CONFIGURATION", "The configuration changed. Refresh and try again.");
}

async function operationLogs(id: string, cursor?: string) {
  let operation = await store.getOperation(id);
  if (!operation) throw new Error("Operation not found.");
  if (!operation.logStreamName && operation.codeBuildId) {
    const build = await codeBuild.send(new BatchGetBuildsCommand({ ids: [operation.codeBuildId] }));
    const stream = build.builds?.[0]?.logs?.streamName;
    if (stream) {
      await store.updateOperation(id, "SET logStreamName = :stream", { ":stream": stream });
      operation = { ...operation, logStreamName: stream };
    }
  }
  if (!operation.logStreamName) return { operationId: id, lines: [], complete: terminal(operation.status) };
  const result = await logs.send(new GetLogEventsCommand({
    logGroupName: operation.logGroupName ?? env.operationLogGroup,
    logStreamName: operation.logStreamName,
    nextToken: cursor,
    startFromHead: true,
    limit: 1_000,
  }));
  return { operationId: id, lines: (result.events ?? []).flatMap((entry) => entry.message ? [entry.message] : []), nextCursor: result.nextForwardToken, complete: terminal(operation.status) };
}

async function checkBudgetedRelease(supportedRange: string): Promise<ReleaseMetadata> {
  const response = await fetch("https://api.github.com/repos/budgetedhq/budgeted/releases", { headers: { Accept: "application/vnd.github+json", "User-Agent": "Budgeted-Launcher" } });
  if (!response.ok) throw new Error(`GitHub release check failed (${response.status}).`);
  const releases = await response.json() as Array<{ tag_name: string; body?: string; published_at?: string; tarball_url: string; html_url: string; draft: boolean; prerelease: boolean }>;
  const stable = releases.filter((item) => !item.draft && !item.prerelease && /^v?\d+\.\d+\.\d+$/.test(item.tag_name) && item.published_at && versionInRange(item.tag_name, supportedRange))
    .sort((a, b) => compareSemver(b.tag_name, a.tag_name))[0];
  if (!stable) throw new Error("No compatible Budgeted release is available. Update Launcher first.");
  const commitResponse = await fetch(`https://api.github.com/repos/budgetedhq/budgeted/commits/${encodeURIComponent(stable.tag_name)}`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "Budgeted-Launcher" } });
  if (!commitResponse.ok) throw new Error(`GitHub release commit lookup failed (${commitResponse.status}).`);
  const commit = await commitResponse.json() as { sha?: string };
  return releaseMetadataSchema.parse({
    tag: stable.tag_name, version: stable.tag_name.replace(/^v/, ""), commitSha: commit.sha,
    publishedAt: stable.published_at, notes: stable.body ?? "", tarballUrl: stable.tarball_url, htmlUrl: stable.html_url,
  });
}

function compareSemver(left: string, right: string) {
  const a = left.replace(/^v/, "").split(".").map(Number);
  const b = right.replace(/^v/, "").split(".").map(Number);
  return (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
}

function terminal(status: string) { return ["succeeded", "failed", "cancelled", "interrupted"].includes(status); }
function ok(body: unknown, statusCode = 200) { return { statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) }; }
function failure(statusCode: number, body: ApiError) { return ok(body, statusCode); }
function safeError(error: unknown) { return error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) }; }
class UnauthorizedError extends Error {}
