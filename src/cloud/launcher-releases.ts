import { createHash, createPublicKey, createVerify } from "node:crypto";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { CloudFormationClient, UpdateStackCommand } from "@aws-sdk/client-cloudformation";

import { launcherReleaseSchema, type LauncherRelease } from "../shared/contracts";

const s3 = new S3Client({});
const cloudFormation = new CloudFormationClient({});

export class LauncherReleaseService {
  constructor(
    private readonly options: { bucket: string; manifestKey: string; installedManifestKey: string; publicKey: string; stackName: string; region: string; roleArn: string },
    private readonly clients: { s3: S3Client; cloudFormation: CloudFormationClient } = { s3, cloudFormation },
  ) {}

  async current(): Promise<LauncherRelease> {
    return this.readManifest(this.options.manifestKey);
  }

  async installed(): Promise<LauncherRelease> {
    return this.readManifest(this.options.installedManifestKey);
  }

  private async readManifest(key: string): Promise<LauncherRelease> {
    const result = await this.clients.s3.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }));
    if (!result.Body) throw new Error("The launcher release manifest is empty.");
    const release = launcherReleaseSchema.parse(JSON.parse(await result.Body.transformToString()));
    this.verify(release);
    return release;
  }

  async update(version: string) {
    const release = await this.current();
    if (release.version !== version) throw new Error("The selected launcher release is no longer current.");
    this.assertTemplateUrl(release.templateUrl, version);
    await this.verifyArtifacts(release);
    await this.clients.cloudFormation.send(new UpdateStackCommand({
      StackName: this.options.stackName,
      TemplateURL: release.templateUrl,
      Capabilities: ["CAPABILITY_NAMED_IAM"],
      UsePreviousTemplate: false,
      Parameters: [{ ParameterKey: "OwnerEmail", UsePreviousValue: true }],
      RoleARN: this.options.roleArn,
    }));
    return { accepted: true, version };
  }

  private async verifyArtifacts(release: LauncherRelease) {
    const expected: Record<string, string> = {
      "template.yaml": release.templateSha256,
      "lambda/api.zip": release.apiSha256,
      "lambda/reconciler.zip": release.reconcilerSha256,
      "lambda/artifacts.zip": release.artifactsSha256,
      "codebuild/runner.zip": release.runnerSha256,
      "renderer.zip": release.rendererSha256,
    };
    for (const [suffix, digest] of Object.entries(expected)) {
      const object = await this.clients.s3.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: `releases/${release.version}/${suffix}` }));
      if (!object.Body) throw new Error(`Launcher artifact ${suffix} is missing.`);
      const actual = createHash("sha256").update(await object.Body.transformToByteArray()).digest("hex");
      if (actual !== digest) throw new Error(`Launcher artifact ${suffix} failed checksum verification.`);
    }
  }

  private verify(release: LauncherRelease) {
    const { signature, ...unsigned } = release;
    const verifier = createVerify("SHA256");
    verifier.update(JSON.stringify(unsigned));
    verifier.end();
    const key = createPublicKey({ key: Buffer.from(this.options.publicKey, "base64"), format: "der", type: "spki" });
    if (!verifier.verify(key, signature, "base64")) throw new Error("The launcher release signature is invalid.");
  }

  private assertTemplateUrl(value: string, version: string) {
    const url = new URL(value);
    const expectedHosts = new Set([
      `${this.options.bucket}.s3.${this.options.region}.amazonaws.com`,
      `${this.options.bucket}.s3.amazonaws.com`,
    ]);
    if (url.protocol !== "https:" || !expectedHosts.has(url.hostname) || url.pathname !== `/releases/${version}/template.yaml`) {
      throw new Error("The launcher template URL is outside the trusted publisher prefix.");
    }
  }
}
