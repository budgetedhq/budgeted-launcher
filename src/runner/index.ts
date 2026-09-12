import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DeleteParametersCommand, GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

import { createConfigurationDocument, createSstSecrets, generateBudgetedToml } from "../core/configuration";
import { DEFAULT_CONFIGURATION, type InstallationState, type LauncherSettingsV2, type LiveSecrets } from "../shared/contracts";
import { StateStore, type RunnerJob } from "../cloud/store";
import { runCommand } from "./command";
import { downloadAndValidateRelease } from "./release";

const operationId = required("OPERATION_ID");
const tableName = required("TABLE_NAME");
const store = new StateStore(tableName);
const ssm = new SSMClient({});

async function main() {
  const job = await store.getRunnerJob(operationId);
  if (!job) throw new Error("The operation job does not exist.");
  const state = await store.getState();
  if (state.activeOperationId !== operationId) throw new Error("The operation is no longer active.");
  const secrets = await readSecrets(job);
  const secretValues = Object.values(secrets);
  const workspace = await mkdtemp(join(tmpdir(), `budgeted-${operationId}-`));
  try {
    await phase(job, "downloading");
    const target = targetRelease(job, state);
    const prepared = await downloadAndValidateRelease({ tag: target.tag, commit: target.commit, expectedDigest: job.action === "prepare" ? undefined : target.digest, directory: workspace });
    await writeConfiguration(prepared.source, state.configuration.toml);
    await phase(job, "installing");
    await command(prepared.source, ["install", "--frozen-lockfile"], secretValues);
    await phase(job, "validating");
    await command(prepared.source, ["exec", "tsx", "--eval", "import {loadBudgetedConfig,resolveStageConfig} from './infra/config.ts';const c=loadBudgetedConfig('./config/budgeted-config.toml');resolveStageConfig(c,c.app.productionStage)"], secretValues);

    if (job.action === "prepare") await prepare(job, state, prepared.source, prepared.digest, secrets);
    if (job.action === "diff") await diff(job, state, prepared.source, requireDigest(target.digest));
    if (["deploy", "redeploy", "rollback"].includes(job.action)) await deploy(job, state, prepared.source, requireDigest(target.digest), secrets);
    if (job.action === "seed") await seed(job, state, prepared.source, secrets);
    if (job.action === "unlock") await runSst(job, state, prepared.source, ["unlock"]);
    if (job.action === "remove") await remove(job, state, prepared.source);
    if (job.action === "verify") await verify(job, state, prepared.source);
    await store.completeOperation(job.id, "succeeded");
  } finally {
    await deleteSecrets(job);
  }
}

async function prepare(job: RunnerJob, state: LauncherSettingsV2, cwd: string, digest: string, secrets: Record<string, string>) {
  await phase(job, "setting-secrets");
  const mapped = createSstSecrets(state.configuration.structured, secrets as LiveSecrets, secrets.authSecret);
  for (const [name, value] of mapped) await runSst(job, state, cwd, ["secret", "set", name], value, Object.values(secrets));
  const release = state.selectedRelease;
  if (!release || release.commitSha !== job.releaseCommit) throw new Error("The prepared release changed while the operation was running.");
  const now = new Date().toISOString();
  await store.updateOperation(job.id, "SET releaseDigest = :digest", { ":digest": digest });
  await store.mutateState(
    "SET selectedRelease = :release, pendingDeployment = :pending, updatedAt = :now",
    { ":release": { ...release, archiveSha256: digest, preparedAt: now }, ":pending": { operationId: job.id, fingerprint: job.fingerprint, releaseTag: release.tag, releaseCommit: job.releaseCommit, releaseDigest: digest, diffSucceeded: false, createdAt: now }, ":now": now },
  );
}

async function diff(job: RunnerJob, state: LauncherSettingsV2, cwd: string, digest: string) {
  await phase(job, "diffing");
  await runSst(job, state, cwd, ["diff"]);
  const now = new Date().toISOString();
  await store.mutateState("SET pendingDeployment = :pending, updatedAt = :now", {
    ":pending": { operationId: job.id, fingerprint: job.fingerprint, releaseTag: job.releaseTag, releaseCommit: job.releaseCommit, releaseDigest: digest, diffSucceeded: true, createdAt: now }, ":now": now,
  });
}

async function deploy(job: RunnerJob, state: LauncherSettingsV2, cwd: string, digest: string, secrets: Record<string, string>) {
  await phase(job, "deploying");
  await runSst(job, state, cwd, ["deploy"]);
  const outputs = JSON.parse(await readFile(join(cwd, ".sst", "outputs.json"), "utf8")) as { app?: string };
  if (!outputs.app) throw new Error("SST completed without a readable application URL.");
  const now = new Date().toISOString();
  const installation: InstallationState = {
    createdByLauncher: true, appName: state.configuration.structured.appName, stage: state.configuration.structured.productionStage,
    releaseTag: job.releaseTag!, releaseCommit: job.releaseCommit!, releaseDigest: digest, fingerprint: job.fingerprint,
    deployedAt: now, appUrl: outputs.app, adminSeeded: state.installation?.adminSeeded ?? false,
  };
  const previous = state.installation?.releaseCommit !== installation.releaseCommit ? state.installation : state.previousRelease;
  await store.mutateState(`SET installation = :installation, updatedAt = :now${previous ? ", previousRelease = :previous" : ""} REMOVE pendingDeployment, uncertainRemoteState`, {
    ":installation": installation, ...(previous ? { ":previous": previous } : {}), ":now": now,
  });
  if (secrets.adminPassword && !installation.adminSeeded) {
    await seed(job, { ...state, installation }, cwd, secrets);
  }
}

async function seed(job: RunnerJob, state: LauncherSettingsV2, cwd: string, secrets: Record<string, string>) {
  if (!state.initialAdmin || !secrets.adminPassword) throw new Error("Administrator email and password are required for seeding.");
  await phase(job, "seeding-user");
  const helper = join(cwd, ".budgeted-launcher-seed.ts");
  await writeFile(helper, seedHelper, { mode: 0o600 });
  await command(cwd, ["exec", "sst", "shell", "--stage", state.configuration.structured.productionStage, "--", "pnpm", "exec", "tsx", helper], Object.values(secrets), JSON.stringify({ ...state.initialAdmin, password: secrets.adminPassword }));
  await store.mutateState("SET installation.adminSeeded = :seeded, updatedAt = :now", { ":seeded": true, ":now": new Date().toISOString() });
}

async function remove(job: RunnerJob, state: LauncherSettingsV2, cwd: string) {
  if (!state.installation) throw new Error("Budgeted is not installed.");
  await phase(job, "deploying");
  const removal = { ...state.configuration.structured, advanced: { ...state.configuration.structured.advanced, protect: false, removal: "remove" as const } };
  await writeConfiguration(cwd, generateBudgetedToml(removal));
  await runSst(job, state, cwd, ["deploy"]);
  await phase(job, "removing");
  await runSst(job, state, cwd, ["remove"]);
  const now = new Date().toISOString();
  await store.mutateState("SET configuration = :configuration, updatedAt = :now REMOVE installation, previousRelease, pendingDeployment, uncertainRemoteState, initialAdmin, selectedRelease, lastReleaseCheckAt", {
    ":configuration": createConfigurationDocument(DEFAULT_CONFIGURATION, state.configuration.revision + 1), ":now": now,
  });
}

async function verify(job: RunnerJob, state: LauncherSettingsV2, cwd: string) {
  await phase(job, "verifying");
  await runSst(job, state, cwd, ["diff"]);
  await store.mutateState("SET updatedAt = :now REMOVE uncertainRemoteState", { ":now": new Date().toISOString() });
}

async function runSst(job: RunnerJob, state: LauncherSettingsV2, cwd: string, args: string[], stdin?: string, secrets: string[] = []) {
  return command(cwd, ["exec", "sst", ...args, "--stage", state.configuration.structured.productionStage], secrets, stdin);
}

async function command(cwd: string, args: string[], secrets: string[], stdin?: string) {
  console.log(`$ pnpm ${args.map((value) => value.includes(" ") ? JSON.stringify(value) : value).join(" ")}`);
  const result = await runCommand("pnpm", args, { cwd, stdin, secrets, env: { CI: "true", NO_COLOR: "1" } });
  console.log(`[exit code: ${result.exitCode}]`);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim().slice(-1_000) || `Command failed with exit code ${result.exitCode}.`);
  return result;
}

async function phase(job: RunnerJob, next: RunnerJob["phase"]) {
  await store.updateOperation(job.id, "SET phase = :phase, #status = :status", { ":phase": next, ":status": "running" });
  console.log(`[phase] ${next}`);
}

async function readSecrets(job: RunnerJob) {
  const result: Record<string, string> = {};
  for (const [key, name] of Object.entries(job.secretParameterNames ?? {})) {
    const value = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    if (!value.Parameter?.Value) throw new Error(`Operation credential ${key} is unavailable.`);
    result[key] = value.Parameter.Value;
  }
  return result;
}

async function deleteSecrets(job: RunnerJob) {
  const names = Object.values(job.secretParameterNames ?? {});
  for (let index = 0; index < names.length; index += 10) await ssm.send(new DeleteParametersCommand({ Names: names.slice(index, index + 10) }));
}

function targetRelease(job: RunnerJob, state: LauncherSettingsV2) {
  if (job.action === "rollback" && state.previousRelease) return { tag: state.previousRelease.releaseTag, commit: state.previousRelease.releaseCommit, digest: state.previousRelease.releaseDigest };
  if (job.releaseTag && job.releaseCommit) return { tag: job.releaseTag, commit: job.releaseCommit, digest: job.releaseDigest ?? state.selectedRelease?.archiveSha256 };
  if (state.installation) return { tag: state.installation.releaseTag, commit: state.installation.releaseCommit, digest: state.installation.releaseDigest };
  throw new Error("The operation has no validated release target.");
}

function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}.`); return value; }
function requireDigest(value: string | undefined) { if (!value) throw new Error("Prepare the release before running this operation."); return value; }
async function writeConfiguration(cwd: string, value: string) {
  const directory = join(cwd, "config");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "budgeted-config.toml"), value, { mode: 0o600 });
}

const seedHelper = `
import { createInterface } from "node:readline";
import { hashPassword } from "./src/lib/auth/password.ts";
import { upsertSeededUserAccount } from "./src/lib/auth/user-account.ts";
const lines = createInterface({ input: process.stdin, terminal: false });
let input = "";
for await (const line of lines) input += line;
const value = JSON.parse(input);
const passwordHash = await hashPassword(value.password);
await upsertSeededUserAccount({ email: value.email, displayName: value.displayName, passwordHash, role: "super" });
console.log("Initial administrator created.");
`;

void main().catch(async (error) => {
  const message = error instanceof Error ? error.message.replace(/[\r\n]+/g, " ").slice(0, 1_000) : "Runner failed.";
  console.error(message);
  await store.completeOperation(operationId, "failed", message).catch(() => undefined);
  process.exitCode = 1;
});
