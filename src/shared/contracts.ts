import { z } from "zod";

export const awsRegionSchema = z.enum([
  "us-east-1", "us-east-2", "us-west-2", "ca-central-1", "eu-west-1",
  "eu-west-2", "eu-central-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1",
]);
export type AwsRegion = z.infer<typeof awsRegionSchema>;
export const SUPPORTED_AWS_REGIONS = awsRegionSchema.options;

const domainSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }),
  z.object({ mode: z.literal("external"), name: z.string().trim().min(1), certificateArn: z.string().startsWith("arn:aws:acm:") }),
  z.object({ mode: z.literal("route53"), name: z.string().trim().min(1), zoneId: z.string().trim().min(1).optional() }),
]);

const venmoEmailSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true), recipient: z.string().email(), allowedForwarders: z.array(z.string().email()),
    dns: z.enum(["external", "aws"]), route53ZoneId: z.string().trim().min(1).optional(),
  }).superRefine((value, context) => {
    if (value.dns === "external" && value.route53ZoneId) {
      context.addIssue({ code: "custom", path: ["route53ZoneId"], message: "A Route 53 zone can only be used with AWS DNS." });
    }
  }),
]);

export const budgetedConfigurationSchema = z.object({
  appName: z.string().trim().min(1).regex(/^budgeted(?:-[a-z0-9]+)*$/, "The application name must be budgeted or start with budgeted-."),
  productionStage: z.string().trim().min(1).regex(/^[a-z0-9-]+$/),
  domain: domainSchema,
  amazonOrders: z.object({ enabled: z.boolean(), apiUrl: z.string() }).superRefine((value, context) => {
    if (value.enabled && !z.string().url().safeParse(value.apiUrl).success) {
      context.addIssue({ code: "custom", path: ["apiUrl"], message: "A valid API URL is required." });
    }
  }),
  plaid: z.object({ enabled: z.boolean(), environment: z.enum(["sandbox", "development", "production"]) }),
  ai: z.object({ openAiEnabled: z.boolean(), googleEnabled: z.boolean() }),
  venmoEmail: venmoEmailSchema,
  advanced: z.object({
    protect: z.boolean(), removal: z.enum(["remove", "retain", "retain-all"]),
    ledgerExportRetentionDays: z.number().int().positive(), ynabImportRetentionDays: z.number().int().positive(),
    ynabImportAllowedOrigins: z.array(z.string().min(1)).min(1), assetLifecycleEnabled: z.boolean(),
    assetRepository: z.string().min(1), assetExpireUntaggedAfterDays: z.number().int().positive(),
    automationEnabled: z.boolean(), automationSchedule: z.string().regex(/^(?:rate|cron|at)\(.+\)$/),
    automationRetries: z.number().int().nonnegative(), automationTimeout: z.string().regex(/^\d+(?:\.\d+)? (?:second|seconds|minute|minutes)$/),
    ynabWorkerMemory: z.string().regex(/^\d+(?:\.\d+)? (?:MB|GB)$/),
    ynabWorkerTimeout: z.string().regex(/^\d+(?:\.\d+)? (?:second|seconds|minute|minutes)$/),
    webTimeout: z.string().regex(/^\d+(?:\.\d+)? (?:second|seconds|minute|minutes)$/),
  }),
});
export type BudgetedConfiguration = z.infer<typeof budgetedConfigurationSchema>;

export const initialAdminSchema = z.object({ email: z.string().email(), displayName: z.string().trim().optional() });
export type InitialAdmin = z.infer<typeof initialAdminSchema>;
export const MIN_ADMIN_PASSWORD_LENGTH = 8;
export const liveSecretsSchema = z.object({
  amazonOrderScraperApiToken: z.string().min(1).optional(), plaidClientId: z.string().min(1).optional(),
  plaidSecret: z.string().min(1).optional(), openAiApiKey: z.string().min(1).optional(),
  googleGenerativeAiApiKey: z.string().min(1).optional(),
  adminPassword: z.string().min(MIN_ADMIN_PASSWORD_LENGTH, `Must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`).optional(),
});
export type LiveSecrets = z.infer<typeof liveSecretsSchema>;

export const releaseMetadataSchema = z.object({
  tag: z.string().regex(/^v?\d+\.\d+\.\d+$/), version: z.string().regex(/^\d+\.\d+\.\d+$/),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/i).optional(), publishedAt: z.string(), notes: z.string(),
  tarballUrl: z.string().url(), htmlUrl: z.string().url(), archiveSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(), preparedAt: z.string().optional(),
});
export type ReleaseMetadata = z.infer<typeof releaseMetadataSchema>;

export const configurationDocumentSchema = z.object({
  structured: budgetedConfigurationSchema, toml: z.string().min(1), source: z.enum(["structured", "toml"]),
  revision: z.number().int().nonnegative(), updatedAt: z.string(),
});
export type ConfigurationDocument = z.infer<typeof configurationDocumentSchema>;

export const operationActionSchema = z.enum(["prepare", "diff", "deploy", "redeploy", "rollback", "unlock", "seed", "remove", "verify"]);
export type OperationAction = z.infer<typeof operationActionSchema>;
export const operationPhaseSchema = z.enum([
  "queued", "downloading", "validating", "installing", "setting-secrets", "diffing", "deploying", "seeding-user",
  "unlocking", "removing", "verifying", "finalizing", "complete", "failed", "cancelled", "interrupted",
]);
export type OperationPhase = z.infer<typeof operationPhaseSchema>;
export const operationStatusSchema = z.enum(["queued", "running", "cancelling", "succeeded", "failed", "cancelled", "interrupted"]);
export type OperationStatus = z.infer<typeof operationStatusSchema>;

export const cloudOperationSchema = z.object({
  id: z.string().uuid(), action: operationActionSchema, inputRevision: z.number().int().nonnegative(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), releaseTag: z.string().optional(), releaseCommit: z.string().optional(),
  releaseDigest: z.string().optional(), phase: operationPhaseSchema, status: operationStatusSchema,
  codeBuildId: z.string().optional(), createdAt: z.string(), startedAt: z.string().optional(), finishedAt: z.string().optional(),
  expiresAt: z.number().int(), error: z.string().optional(), cancellationRequestedAt: z.string().optional(),
  remoteStateUncertain: z.boolean().default(false), logGroupName: z.string().optional(), logStreamName: z.string().optional(),
});
export type CloudOperation = z.infer<typeof cloudOperationSchema>;

export const installationStateSchema = z.object({
  createdByLauncher: z.literal(true), appName: z.string(), stage: z.string(), releaseTag: z.string(), releaseCommit: z.string(),
  releaseDigest: z.string(), fingerprint: z.string(), deployedAt: z.string(), appUrl: z.string().url(), adminSeeded: z.boolean(),
});
export type InstallationState = z.infer<typeof installationStateSchema>;

const deploymentReferenceSchema = z.object({
  operationId: z.string().uuid(), fingerprint: z.string(), releaseTag: z.string(), releaseCommit: z.string(),
  releaseDigest: z.string(), diffSucceeded: z.boolean(), createdAt: z.string(),
});

export const launcherSettingsV2Schema = z.object({
  schemaVersion: z.literal(2), repository: z.literal("budgetedhq/budgeted"), ownerEmail: z.string().email(),
  awsAccountId: z.string().regex(/^\d{12}$/), awsRegion: awsRegionSchema, launcherVersion: z.string(),
  configuration: configurationDocumentSchema, initialAdmin: initialAdminSchema.optional(), selectedRelease: releaseMetadataSchema.optional(),
  pendingDeployment: deploymentReferenceSchema.optional(), installation: installationStateSchema.optional(), previousRelease: installationStateSchema.optional(),
  activeOperationId: z.string().uuid().optional(), latestOperationIds: z.array(z.string().uuid()).max(20).default([]),
  uncertainRemoteState: z.object({ action: operationActionSchema, operationId: z.string().uuid(), markedAt: z.string() }).optional(),
  lastReleaseCheckAt: z.string().optional(), updatedAt: z.string(),
});
export type LauncherSettingsV2 = z.infer<typeof launcherSettingsV2Schema>;

export const apiErrorSchema = z.object({
  code: z.string(), message: z.string(), fieldErrors: z.record(z.string(), z.array(z.string())).optional(), requestId: z.string(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
export const logPageSchema = z.object({ operationId: z.string().uuid(), lines: z.array(z.string()), nextCursor: z.string().optional(), complete: z.boolean() });
export type LogPage = z.infer<typeof logPageSchema>;
export const launcherReleaseSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/), notes: z.string(), publishedAt: z.string(), supportedBudgetedRange: z.string(),
  templateUrl: z.string().url(), templateSha256: z.string().regex(/^[a-f0-9]{64}$/), apiSha256: z.string().regex(/^[a-f0-9]{64}$/),
  reconcilerSha256: z.string().regex(/^[a-f0-9]{64}$/), artifactsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  runnerSha256: z.string().regex(/^[a-f0-9]{64}$/), rendererSha256: z.string().regex(/^[a-f0-9]{64}$/), signature: z.string(),
});
export type LauncherRelease = z.infer<typeof launcherReleaseSchema>;

export const runtimeConfigSchema = z.object({
  apiUrl: z.string().url(), awsRegion: awsRegionSchema,
  userPoolId: z.string(), userPoolClientId: z.string(), cognitoDomain: z.string().url(), callbackUrl: z.string().url(), launcherVersion: z.string(),
});
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
export type LauncherSnapshot = { settings: LauncherSettingsV2; activeOperation?: CloudOperation; latestOperations: CloudOperation[] };

export const saveConfigurationRequestSchema = z.object({
  configurationRevision: z.number().int().nonnegative(), configuration: budgetedConfigurationSchema, initialAdmin: initialAdminSchema.optional(),
});
export const saveTomlRequestSchema = z.object({ configurationRevision: z.number().int().nonnegative(), toml: z.string().min(1) });
export const releaseCheckRequestSchema = z.object({ configurationRevision: z.number().int().nonnegative() });
export const operationRequestSchema = z.object({
  configurationRevision: z.number().int().nonnegative(), release: releaseMetadataSchema.optional(), acknowledged: z.boolean().optional(), secrets: liveSecretsSchema.optional(),
});
const revisionRequestSchema = z.object({ configurationRevision: z.number().int().nonnegative() });
export const operationRequestSchemas = {
  prepare: operationRequestSchema,
  diff: revisionRequestSchema,
  deploy: operationRequestSchema.extend({ acknowledged: z.literal(true) }),
  redeploy: revisionRequestSchema,
  rollback: revisionRequestSchema,
  unlock: revisionRequestSchema,
  seed: operationRequestSchema.extend({ secrets: liveSecretsSchema }),
  remove: revisionRequestSchema.extend({ acknowledged: z.literal(true) }),
  verify: revisionRequestSchema,
} satisfies Record<OperationAction, z.ZodType>;
export const launcherUpdateRequestSchema = z.object({ configurationRevision: z.number().int().nonnegative(), version: z.string(), acknowledged: z.literal(true) });
export type OperationRequest = z.infer<typeof operationRequestSchema>;

export const DEFAULT_CONFIGURATION: BudgetedConfiguration = {
  appName: "budgeted", productionStage: "production", domain: { mode: "none" }, amazonOrders: { enabled: false, apiUrl: "" },
  plaid: { enabled: false, environment: "sandbox" }, ai: { openAiEnabled: false, googleEnabled: false }, venmoEmail: { enabled: false },
  advanced: {
    protect: true, removal: "retain", ledgerExportRetentionDays: 1, ynabImportRetentionDays: 2, ynabImportAllowedOrigins: ["*"],
    assetLifecycleEnabled: true, assetRepository: "sst-asset", assetExpireUntaggedAfterDays: 3, automationEnabled: true,
    automationSchedule: "cron(0/2 * * * ? *)", automationRetries: 0, automationTimeout: "15 minutes",
    ynabWorkerMemory: "2 GB", ynabWorkerTimeout: "15 minutes", webTimeout: "60 seconds",
  },
};
