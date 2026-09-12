import { randomBytes, randomUUID } from "node:crypto";

import { StartBuildCommand, StopBuildCommand, CodeBuildClient } from "@aws-sdk/client-codebuild";
import { DeleteParametersCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

import { createConfigurationFingerprint, validateSecrets } from "../core/configuration";
import { liveSecretsSchema, operationRequestSchemas, type CloudOperation, type LiveSecrets, type OperationAction, type OperationRequest } from "../shared/contracts";
import { StateStore } from "./store";

const codeBuild = new CodeBuildClient({});
const ssm = new SSMClient({});
const NINETY_DAYS = 90 * 24 * 60 * 60;

export class OperationService {
  constructor(
    private readonly store: StateStore,
    private readonly options: { projectName: string; parameterPrefix: string; logGroupName: string },
  ) {}

  async start(action: OperationAction, body: unknown, idempotencyKey: string) {
    const request = operationRequestSchemas[action].parse(body) as OperationRequest;
    const state = await this.store.getState();
    const release = request.release ?? state.selectedRelease;
    const installed = state.installation ? installationRelease(state.installation) : undefined;
    const pending = state.pendingDeployment ? {
      tag: state.pendingDeployment.releaseTag, version: state.pendingDeployment.releaseTag.replace(/^v/, ""),
      commitSha: state.pendingDeployment.releaseCommit, archiveSha256: state.pendingDeployment.releaseDigest,
      publishedAt: state.pendingDeployment.createdAt, notes: "", tarballUrl: `https://api.github.com/repos/budgetedhq/budgeted/tarball/${state.pendingDeployment.releaseCommit}`,
      htmlUrl: `https://github.com/budgetedhq/budgeted/releases/tag/${state.pendingDeployment.releaseTag}`,
    } : undefined;
    const target = action === "prepare" ? release
      : action === "rollback" && state.previousRelease ? installationRelease(state.previousRelease)
        : ["diff", "deploy"].includes(action) ? pending ?? installed
          : installed;
    if (!target?.commitSha && !["unlock", "remove", "verify"].includes(action)) throw new Error("Prepare a stable Budgeted release before starting this operation.");
    if (action === "rollback" && (!state.previousRelease || target?.commitSha !== state.previousRelease.releaseCommit)) {
      throw new Error("Rollback is limited to the previous launcher-managed release.");
    }
    if (state.uncertainRemoteState && action !== "verify") throw new Error("Verify the interrupted deployment state before starting another mutation.");
    if (action === "deploy" && !request.acknowledged) throw new Error("Deployment acknowledgement is required.");
    if (action === "remove" && !request.acknowledged) throw new Error("Removal acknowledgement is required.");
    if (action === "deploy" && !state.installation && (!state.pendingDeployment?.diffSucceeded || state.pendingDeployment.fingerprint !== fingerprint(state, target!.commitSha!))) {
      throw new Error("The initial deployment requires a successful matching SST diff.");
    }

    const secrets = request.secrets ?? {};
    if (action === "prepare" && !state.installation) validateSecrets(state.configuration.structured, secrets);
    else liveSecretsSchema.parse(secrets);
    if ((action === "deploy" && !state.installation) || action === "seed") {
      if (!secrets.adminPassword) throw new Error("The initial administrator password is required.");
    }
    const id = randomUUID();
    const now = new Date();
    const operation: CloudOperation = {
      id,
      action,
      inputRevision: request.configurationRevision,
      fingerprint: fingerprint(state, target?.commitSha ?? state.installation?.releaseCommit ?? "none"),
      releaseTag: target?.tag,
      releaseCommit: target?.commitSha,
      releaseDigest: target?.archiveSha256,
      phase: "queued",
      status: "queued",
      createdAt: now.toISOString(),
      expiresAt: Math.floor(now.getTime() / 1000) + NINETY_DAYS,
      remoteStateUncertain: false,
      logGroupName: this.options.logGroupName,
    };
    const values: LiveSecrets & { authSecret?: string } = action === "prepare"
      ? { ...secrets, adminPassword: undefined }
      : ["deploy", "seed"].includes(action)
        ? { adminPassword: secrets.adminPassword }
        : {};
    if (action === "prepare") values.authSecret = randomBytes(48).toString("base64url");
    const parameterNames = await this.writeSecrets(id, values);
    try {
      const stored = await this.store.startOperation({
        operation, expectedRevision: request.configurationRevision, idempotencyKey,
        initialAdmin: state.initialAdmin, secretParameterNames: parameterNames,
      });
      if (stored.id !== id) {
        await this.deleteSecrets(Object.values(parameterNames));
        return stored;
      }
      const build = await codeBuild.send(new StartBuildCommand({
        projectName: this.options.projectName,
        environmentVariablesOverride: [{ name: "OPERATION_ID", value: id, type: "PLAINTEXT" }],
      }));
      if (!build.build?.id) throw new Error("CodeBuild did not return a build identifier.");
      await this.store.attachBuild(id, build.build.id, build.build.logs?.streamName);
      return await this.store.getOperation(id);
    } catch (error) {
      await this.deleteSecrets(Object.values(parameterNames));
      await this.store.completeOperation(id, "failed", safeError(error)).catch(() => undefined);
      throw error;
    }
  }

  async cancel(id: string, expectedRevision: number) {
    const state = await this.store.getState();
    if (state.configuration.revision !== expectedRevision) throw new Error("The configuration changed. Refresh and try again.");
    const operation = await this.store.getOperation(id);
    if (!operation || state.activeOperationId !== id) throw new Error("The operation is not active.");
    const now = new Date().toISOString();
    await this.store.updateOperation(id, "SET #status = :status, cancellationRequestedAt = :now", { ":status": "cancelling", ":now": now });
    if (operation.codeBuildId) await codeBuild.send(new StopBuildCommand({ id: operation.codeBuildId }));
    return this.store.getOperation(id);
  }

  private async writeSecrets(operationId: string, secrets: Record<string, string | undefined>) {
    const entries = Object.entries(secrets).filter((entry): entry is [string, string] => Boolean(entry[1]));
    const names: Record<string, string> = {};
    await Promise.all(entries.map(async ([key, value]) => {
      const name = `${this.options.parameterPrefix}/${operationId}/${key}`;
      await ssm.send(new PutParameterCommand({ Name: name, Type: "SecureString", Value: value, Overwrite: false, Tier: "Standard" }));
      names[key] = name;
    }));
    return names;
  }

  private async deleteSecrets(names: string[]) {
    for (let index = 0; index < names.length; index += 10) {
      await ssm.send(new DeleteParametersCommand({ Names: names.slice(index, index + 10) }));
    }
  }
}

function fingerprint(state: Awaited<ReturnType<StateStore["getState"]>>, releaseCommit: string) {
  return createConfigurationFingerprint({ awsAccountId: state.awsAccountId, awsRegion: state.awsRegion, releaseCommit, configuration: state.configuration });
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message.replace(/[\r\n]+/g, " ").slice(0, 1000) : "Operation failed.";
}

function installationRelease(value: NonNullable<Awaited<ReturnType<StateStore["getState"]>>["installation"]>) {
  return {
    tag: value.releaseTag, version: value.releaseTag.replace(/^v/, ""), commitSha: value.releaseCommit, archiveSha256: value.releaseDigest,
    publishedAt: value.deployedAt, notes: "", tarballUrl: `https://api.github.com/repos/budgetedhq/budgeted/tarball/${value.releaseCommit}`,
    htmlUrl: `https://github.com/budgetedhq/budgeted/releases/tag/${value.releaseTag}`,
  };
}
