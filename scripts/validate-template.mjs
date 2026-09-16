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
const userPool = source.slice(source.indexOf("  UserPool:\n"), source.indexOf("  OwnerUser:\n"));
if (!userPool.includes("AllowedFirstAuthFactors: [EMAIL_OTP]")) throw new Error("The owner user pool must allow EMAIL_OTP as its first authentication factor.");
if (userPool.includes("PASSWORD")) throw new Error("The passwordless owner user pool must not enable PASSWORD authentication.");
if (!userPool.includes("AccountRecoverySetting:")) throw new Error("The passwordless owner user pool must explicitly configure account recovery.");
if (!userPool.includes("- Name: admin_only")) throw new Error("The passwordless owner user pool must disable self-service password recovery with admin_only.");
if (userPool.includes("verified_email") || userPool.includes("verified_phone_number")) throw new Error("The passwordless owner user pool must not enable email or phone password recovery.");
process.stdout.write("CloudFormation appliance invariants validated.\n");
