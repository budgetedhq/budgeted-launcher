import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

describe("CloudFormation appliance", () => {
  it("has OwnerEmail as its only user parameter and never removes Budgeted on launcher deletion", async () => {
    const template = await readFile(resolve(process.cwd(), "infra/launcher.yaml"), "utf8");
    const parameters = template.slice(template.indexOf("Parameters:"), template.indexOf("Mappings:"));
    expect(parameters.match(/^ {2}[A-Za-z][A-Za-z0-9]+:/gm)).toEqual(["  OwnerEmail:"]);
    expect(template).not.toContain("Custom::RemoveBudgeted");
    expect(template).toContain("PrivilegedMode: false");
    expect(template).toContain("ConcurrentBuildLimit: 1");
    expect(template).toContain("PointInTimeRecoveryEnabled: true");
  });

  it("keeps the owner user pool passwordless without password recovery", async () => {
    const template = await readFile(resolve(process.cwd(), "infra/launcher.yaml"), "utf8");
    const userPool = template.slice(template.indexOf("  UserPool:\n"), template.indexOf("  OwnerUser:\n"));

    expect(userPool).toContain("AllowedFirstAuthFactors: [EMAIL_OTP]");
    expect(userPool).not.toContain("PASSWORD");
    expect(userPool).toContain("AccountRecoverySetting:");
    expect(userPool).toContain("- Name: admin_only");
    expect(userPool).not.toContain("verified_email");
    expect(userPool).not.toContain("verified_phone_number");
  });
});
