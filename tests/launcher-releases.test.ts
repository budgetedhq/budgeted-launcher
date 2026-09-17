import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { vi } from "vitest";

import { LauncherReleaseService } from "../src/cloud/launcher-releases";

describe("launcher release manifests", () => {
  it("reads installed-launcher compatibility from its immutable release manifest", async () => {
    const send = vi.fn().mockResolvedValue({});
    const service = new LauncherReleaseService({
      bucket: "publisher-bucket",
      manifestKey: "stable/manifest.json",
      installedManifestKey: "releases/0.2.7/manifest.json",
      publicKey: "unused",
      stackName: "BudgetedLauncher",
      region: "us-east-1",
      roleArn: "arn:aws:iam::123456789012:role/updater",
    }, {
      s3: { send } as unknown as S3Client,
      cloudFormation: {} as CloudFormationClient,
    });

    await expect(service.installed()).rejects.toThrow("manifest is empty");
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetObjectCommand);
    expect((send.mock.calls[0][0] as GetObjectCommand).input).toEqual({
      Bucket: "publisher-bucket",
      Key: "releases/0.2.7/manifest.json",
    });
  });
});
