import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
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

  it("does not expose bucket listing and separates staging from promotion", async () => {
    const template = await readFile(resolve(process.cwd(), "infra/publisher.yaml"), "utf8");
    const deploymentScript = await readFile(resolve(process.cwd(), "deploy/deploy-stacks.sh"), "utf8");
    expect(template).not.toContain("PublicReleaseList");
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
});
