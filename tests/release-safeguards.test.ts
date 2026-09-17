import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

describe("release safeguards", () => {
  it("requires the release tag to exactly match the stable package version", async () => {
    const packageJson = JSON.parse(await readFile(resolve(process.cwd(), "package.json"), "utf8")) as { version: string };
    expect(() => execFileSync(process.execPath, ["scripts/validate-release-tag.mjs", `v${packageJson.version}`])).not.toThrow();
    expect(spawnSync(process.execPath, ["scripts/validate-release-tag.mjs", "v99.0.0"]).status).not.toBe(0);
  });

  it("refuses to package publishable artifacts without the manifest public key", () => {
    const result = spawnSync(process.execPath, ["scripts/package-cloud.mjs"], {
      env: { ...process.env, LAUNCHER_MANIFEST_PUBLIC_KEY: "", REQUIRE_PUBLISHABLE_ARTIFACTS: "true" },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr.toString()).toContain("LAUNCHER_MANIFEST_PUBLIC_KEY is required");
  });

  it("pins actions and protects staged and promoted releases", async () => {
    const workflow = await readFile(resolve(process.cwd(), ".github/workflows/release.yml"), "utf8");
    const actionReferences = [...workflow.matchAll(/uses:\s+[^@\s]+@([^\s#]+)/g)].map((match) => match[1]);
    expect(actionReferences.length).toBeGreaterThan(0);
    expect(actionReferences.every((reference) => /^[a-f0-9]{40}$/.test(reference))).toBe(true);
    expect(workflow).toContain("group: budgeted-launcher-release");
    expect(workflow).toContain("environment: publisher-staging");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("rollback-promotion:");
    expect(workflow).toContain("max-parallel: 1");
    expect(workflow).toContain("IAM_VALIDATED_LAUNCHER_VERSION");
  });

  it("limits public bucket listing to release renderer assets and separates staging from promotion", async () => {
    const template = await readFile(resolve(process.cwd(), "infra/publisher.yaml"), "utf8");
    const deploymentScript = await readFile(resolve(process.cwd(), "deploy/deploy-stacks.sh"), "utf8");
    const bucketPolicy = template.slice(template.indexOf("  PublisherBucketPolicy:\n"), template.indexOf("  GitHubStagingRole:\n"));
    const rendererListStatement = bucketPolicy.slice(
      bucketPolicy.indexOf("          - Sid: PublicReleaseRendererList\n"),
      bucketPolicy.indexOf("          - Sid: PublicReleaseRead\n"),
    );
    expect(bucketPolicy.match(/Action: s3:ListBucket/g)).toHaveLength(1);
    expect(rendererListStatement).toContain('Principal: "*"');
    expect(rendererListStatement).toContain("Action: s3:ListBucket");
    expect(rendererListStatement).toContain("Condition:");
    expect(rendererListStatement).toContain('s3:prefix:');
    expect(rendererListStatement).toContain('- "releases/*/renderer/"');
    expect(rendererListStatement).toContain('- "releases/*/renderer/*"');
    expect(template).toContain("BudgetedLauncherStager-${AWS::Region}");
    expect(template).toContain("BudgetedLauncherPromoter-${AWS::Region}");
    expect(template).toContain("promotion-backups/");
    expect(template).toContain("GitHubOidcSubjectPrefix:");
    expect(template).toContain("repo:budgetedhq@327071714/budgeted-launcher@1367179722");
    expect(template).toContain("${GitHubOidcSubjectPrefix}:environment:${GitHubStagingEnvironment}");
    expect(template).toContain("${GitHubOidcSubjectPrefix}:environment:${GitHubProductionEnvironment}");
    expect(template).not.toContain("repo:${GitHubRepository}:environment:");
    expect(deploymentScript).toContain("GitHubOidcSubjectPrefix=\"${github_oidc_subject_prefix}\"");
  });

  it("deploys publisher regions concurrently and reports each region's status", async () => {
    const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "budgeted-launcher-deploy-test-"));
    const binDirectory = resolve(temporaryDirectory, "bin");
    const deployedRegionsFile = resolve(temporaryDirectory, "deployed-regions");
    await mkdir(binDirectory);
    await writeFile(
      resolve(binDirectory, "aws"),
      `#!/bin/bash
if [[ "$1" == "sts" ]]; then
  printf '123456789012\\n'
  exit 0
fi
if [[ "$1" == "cloudformation" && "$2" == "deploy" ]]; then
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "--region" ]]; then
      printf '%s\\n' "$2" >> "$MOCK_DEPLOYED_REGIONS_FILE"
      break
    fi
    shift
  done
  sleep 1
  exit 0
fi
exit 1
`,
    );
    await chmod(resolve(binDirectory, "aws"), 0o755);

    try {
      const startedAt = performance.now();
      const result = spawnSync("bash", [resolve(process.cwd(), "deploy/deploy-stacks.sh")], {
        encoding: "utf8",
        input: "y\n",
        env: {
          ...process.env,
          AWS_PROFILE: "test-publisher",
          MAX_PARALLEL_DEPLOYS: "10",
          MOCK_DEPLOYED_REGIONS_FILE: deployedRegionsFile,
          PATH: `${binDirectory}:${process.env.PATH}`,
        },
      });
      const elapsedMilliseconds = performance.now() - startedAt;

      expect(result.status).toBe(0);
      expect(elapsedMilliseconds).toBeLessThan(4_000);
      expect((await readFile(deployedRegionsFile, "utf8")).trim().split("\n")).toHaveLength(10);
      expect(result.stdout).toContain("Publisher deployment status");
      expect(result.stdout).toMatch(/us-east-1\s+SUCCEEDED/);
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
