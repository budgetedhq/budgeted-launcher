import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../infra/launcher.yaml", import.meta.url), "utf8");
const requirements = [
  "OwnerEmail:", "AWS::CloudFront::OriginAccessControl", "AWS::Cognito::UserPool", "EMAIL_OTP",
  "AWS::ApiGatewayV2::Authorizer", "nodejs24.x", "BUILD_GENERAL1_MEDIUM", "ConcurrentBuildLimit: 1",
  "TimeoutInMinutes: 120", "PrivilegedMode: false", "PointInTimeRecoveryEnabled: true", "RetentionInDays: 30",
  "LauncherUrl:", "LauncherVersion:", "AwsAccountId:", "AwsRegion:",
];
const missing = requirements.filter((value) => !source.includes(value));
if (missing.length) throw new Error(`CloudFormation template is missing: ${missing.join(", ")}`);
const parameters = source.slice(source.indexOf("Parameters:"), source.indexOf("Mappings:"));
if ((parameters.match(/^ {2}[A-Za-z][A-Za-z0-9]+:/gm) ?? []).join(",") !== "  OwnerEmail:") throw new Error("OwnerEmail must be the template's only parameter.");
process.stdout.write("CloudFormation appliance invariants validated.\n");
