import { apiErrorSchema, DEFAULT_CONFIGURATION, type ApiError, type BudgetedConfiguration, type CloudOperation, type InitialAdmin, type LauncherRelease, type LauncherSnapshot, type LiveSecrets, type LogPage, type OperationAction, type ReleaseMetadata } from "../shared/contracts";
import { getIdToken, getRuntimeConfig } from "./auth";

type RequestOptions = { method?: "GET" | "POST" | "PUT"; body?: unknown; idempotent?: boolean };

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (import.meta.env.DEV) return mockRequest(path, options) as T;
  const token = getIdToken();
  if (!token) throw new Error("Your session expired. Sign in again.");
  const response = await fetch(new URL(path, getRuntimeConfig().apiUrl), {
    method: options.method ?? "GET",
    cache: "no-store",
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.idempotent ? { "idempotency-key": crypto.randomUUID() + crypto.randomUUID() } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const value: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(value);
    if (parsed.success) throw new ApiRequestError(parsed.data);
    throw new Error("Launcher request failed.");
  }
  return value as T;
}

export type ApiFieldIssue = { field: string; message: string };

const FIELD_LABELS: Record<string, string> = {
  "configuration.appName": "Application name",
  "configuration.productionStage": "Production stage",
  "configuration.domain.name": "Domain name",
  "configuration.domain.certificateArn": "ACM certificate ARN",
  "initialAdmin.email": "Administrator email",
  "secrets.adminPassword": "Administrator password",
};

export class ApiRequestError extends Error {
  constructor(readonly response: ApiError) {
    super(formatApiError(response));
    this.name = "ApiRequestError";
  }
}

export function apiFieldIssues(value: ApiError): ApiFieldIssue[] {
  return Object.entries(value.fieldErrors ?? {}).flatMap(([path, messages]) => messages.map((message) => ({
    field: FIELD_LABELS[path] ?? humanizeFieldPath(path),
    message,
  })));
}

export function formatApiError(value: unknown) {
  const parsed = apiErrorSchema.safeParse(value);
  if (!parsed.success) return "Launcher request failed.";
  const details = apiFieldIssues(parsed.data).map(({ field, message }) => `${field}: ${message}`);
  const message = details.length ? [...new Set(details)].join(" ") : parsed.data.message;
  return `${message} (${parsed.data.requestId})`;
}

function humanizeFieldPath(path: string) {
  const field = path.split(".").at(-1) ?? path;
  const words = field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const api = {
  snapshot: () => request<LauncherSnapshot>("api/v1/snapshot"),
  saveConfiguration: (revision: number, configuration: BudgetedConfiguration, initialAdmin?: InitialAdmin) => request("api/v1/configuration", { method: "PUT", idempotent: true, body: { configurationRevision: revision, configuration, initialAdmin } }),
  getToml: () => request<{ toml: string; source: "structured" | "toml"; configurationRevision: number }>("api/v1/configuration/toml"),
  saveToml: (revision: number, toml: string) => request("api/v1/configuration/toml", { method: "PUT", idempotent: true, body: { configurationRevision: revision, toml } }),
  checkBudgetedRelease: (revision: number) => request<ReleaseMetadata>("api/v1/releases/check", { method: "POST", idempotent: true, body: { configurationRevision: revision } }),
  startOperation: (action: OperationAction, revision: number, input: { release?: ReleaseMetadata; acknowledged?: boolean; secrets?: LiveSecrets } = {}) => request<CloudOperation>(`api/v1/operations/${action}`, { method: "POST", idempotent: true, body: { configurationRevision: revision, ...input } }),
  operation: (id: string) => request<CloudOperation>(`api/v1/operations/${id}`),
  logs: (id: string, cursor?: string) => request<LogPage>(`api/v1/operations/${id}/logs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
  cancel: (id: string, revision: number) => request<CloudOperation>(`api/v1/operations/${id}/cancel`, { method: "POST", idempotent: true, body: { configurationRevision: revision } }),
  launcherRelease: () => request<LauncherRelease>("api/v1/launcher/releases"),
  updateLauncher: (revision: number, version: string) => request(`api/v1/launcher/update`, { method: "POST", idempotent: true, body: { configurationRevision: revision, version, acknowledged: true } }),
};

export async function updateLauncherAndWait(revision: number, version: string) {
  await api.updateLauncher(revision, version);
  let lastError: unknown;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, import.meta.env.DEV ? 10 : 5_000));
    try {
      const next = await api.snapshot();
      if (next.settings.launcherVersion === version) return next;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`CloudFormation did not complete the Launcher update. The previous interface remains available after rollback.${lastError instanceof Error ? ` ${lastError.message}` : ""}`);
}

let mock: LauncherSnapshot;
function ensureMock() {
  if (mock) return;
  const now = new Date().toISOString();
  mock = { settings: {
    schemaVersion: 2, repository: "budgetedhq/budgeted", ownerEmail: "owner@example.com", awsAccountId: "123456789012", awsRegion: "us-east-1",
    launcherVersion: "dev", configuration: { structured: DEFAULT_CONFIGURATION, toml: mockToml(), source: "structured", revision: 0, updatedAt: now },
    latestOperationIds: [], updatedAt: now,
  }, latestOperations: [] };
}

function mockRequest(path: string, options: RequestOptions) {
  ensureMock();
  if (path === "api/v1/snapshot") return structuredClone(mock);
  if (path === "api/v1/configuration/toml" && !options.body) return { toml: mock.settings.configuration.toml, source: mock.settings.configuration.source, configurationRevision: mock.settings.configuration.revision };
  if (path === "api/v1/configuration") {
    const body = options.body as { configuration: BudgetedConfiguration; initialAdmin?: InitialAdmin };
    mock.settings.configuration = { structured: body.configuration, toml: mockToml(body.configuration), source: "structured", revision: mock.settings.configuration.revision + 1, updatedAt: new Date().toISOString() };
    mock.settings.initialAdmin = body.initialAdmin;
    return structuredClone(mock.settings);
  }
  if (path === "api/v1/configuration/toml") {
    const body = options.body as { toml: string };
    mock.settings.configuration = { ...mock.settings.configuration, toml: body.toml, source: "toml", revision: mock.settings.configuration.revision + 1, updatedAt: new Date().toISOString() };
    return structuredClone(mock.settings);
  }
  if (path === "api/v1/releases/check") {
    const release = { tag: "v0.1.2", version: "0.1.2", commitSha: "a".repeat(40), archiveSha256: "b".repeat(64), publishedAt: new Date().toISOString(), notes: "Development release", tarballUrl: "https://api.github.com/repos/budgetedhq/budgeted/tarball/v0.1.2", htmlUrl: "https://github.com/budgetedhq/budgeted/releases/tag/v0.1.2" };
    mock.settings.selectedRelease = release;
    return release;
  }
  if (/api\/v1\/operations\/(prepare|diff|deploy|redeploy|rollback|unlock|seed|remove|verify)$/.test(path)) {
    const action = path.split("/").at(-1) as OperationAction;
    const operation = { id: crypto.randomUUID(), action, inputRevision: mock.settings.configuration.revision, fingerprint: "c".repeat(64), releaseTag: mock.settings.selectedRelease?.tag, releaseCommit: mock.settings.selectedRelease?.commitSha, releaseDigest: mock.settings.selectedRelease?.archiveSha256, phase: "complete" as const, status: "succeeded" as const, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), expiresAt: Math.floor(Date.now() / 1000) + 86400, remoteStateUncertain: false };
    mock.latestOperations.unshift(operation);
    mock.settings.latestOperationIds.unshift(operation.id);
    if (action === "prepare" && mock.settings.selectedRelease) mock.settings.pendingDeployment = { operationId: operation.id, fingerprint: operation.fingerprint, releaseTag: operation.releaseTag!, releaseCommit: operation.releaseCommit!, releaseDigest: operation.releaseDigest!, diffSucceeded: false, createdAt: operation.createdAt };
    if (action === "diff" && mock.settings.pendingDeployment) mock.settings.pendingDeployment.diffSucceeded = true;
    return operation;
  }
  if (/\/logs(?:\?|$)/.test(path)) return { operationId: path.split("/")[4], lines: ["Development harness: sanitized operation output."], complete: true };
  if (path === "api/v1/launcher/releases") return { version: "0.2.8", notes: "No update in the development harness.", publishedAt: new Date().toISOString(), supportedBudgetedRange: ">=0.1.0 <1.0.0", templateUrl: "https://example.com/releases/0.2.8/template.yaml", templateSha256: "a".repeat(64), apiSha256: "a".repeat(64), reconcilerSha256: "a".repeat(64), artifactsSha256: "a".repeat(64), runnerSha256: "a".repeat(64), rendererSha256: "a".repeat(64), signature: "development" };
  if (path === "api/v1/launcher/update") { mock.settings.launcherVersion = String((options.body as { version: string }).version); return { accepted: true }; }
  return {};
}

function mockToml(configuration = DEFAULT_CONFIGURATION) {
  return `# Development harness\n[app]\nname = "${configuration.appName}"\nproductionStage = "${configuration.productionStage}"\n`;
}
