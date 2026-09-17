import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../infra/launcher.yaml", import.meta.url), "utf8");
const requirements = [
  "OwnerEmail:", "AWS::CloudFront::OriginAccessControl", "AWS::Cognito::UserPool", "EMAIL_OTP",
  "AWS::Cognito::ManagedLoginBranding", "UseCognitoProvidedValues: true",
  "AWS::ApiGatewayV2::Authorizer", "nodejs24.x", "BUILD_GENERAL1_MEDIUM", "ConcurrentBuildLimit: 1",
  "TimeoutInMinutes: 120", "PrivilegedMode: false", "PointInTimeRecoveryEnabled: true", "RetentionInDays: 30",
  "s3:PutBucketNotification", "LauncherUrl:", "LauncherVersion:", "AwsAccountId:", "AwsRegion:",
];
const missing = requirements.filter((value) => !source.includes(value));
if (missing.length) throw new Error(`CloudFormation template is missing: ${missing.join(", ")}`);
const parameters = source.slice(source.indexOf("Parameters:"), source.indexOf("Mappings:"));
if ((parameters.match(/^ {2}[A-Za-z][A-Za-z0-9]+:/gm) ?? []).join(",") !== "  OwnerEmail:") throw new Error("OwnerEmail must be the template's only parameter.");
const distribution = source.slice(source.indexOf("  Distribution:\n"), source.indexOf("  AssetBucketPolicy:\n"));
const cachePolicyIds = [...distribution.matchAll(/CachePolicyId: ([0-9a-f-]+)/g)].map((match) => match[1]);
const expectedCachePolicyIds = ["658327ea-f89d-4fab-a63d-7e88639e58f6", "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"];
if (cachePolicyIds.join(",") !== expectedCachePolicyIds.join(",")) throw new Error("CloudFront must use the managed CachingOptimized and CachingDisabled policy IDs.");
if (!distribution.includes("OriginRequestPolicyId: b689b0a8-53d0-40ab-baf2-68738e2966ac")) throw new Error("The API origin must use the managed AllViewerExceptHostHeader policy ID.");
const userPool = source.slice(source.indexOf("  UserPool:\n"), source.indexOf("  OwnerUser:\n"));
if (!userPool.includes("AllowedFirstAuthFactors: [PASSWORD, EMAIL_OTP]")) throw new Error("The owner user pool must include Cognito's required PASSWORD factor and EMAIL_OTP.");
if (!userPool.includes("AccountRecoverySetting:")) throw new Error("The passwordless owner user pool must explicitly configure account recovery.");
if (!userPool.includes("- Name: admin_only")) throw new Error("The passwordless owner user pool must disable self-service password recovery with admin_only.");
if (userPool.includes("verified_email") || userPool.includes("verified_phone_number")) throw new Error("The passwordless owner user pool must not enable email or phone password recovery.");
const ownerUser = source.slice(source.indexOf("  OwnerUser:\n"), source.indexOf("  UserPoolDomain:\n"));
if (ownerUser.includes("TemporaryPassword:")) throw new Error("The owner user must not be assigned a Cognito password.");
const userPoolClient = source.slice(source.indexOf("  UserPoolClient:\n"), source.indexOf("  ApiAuthorizer:\n"));
if (!userPoolClient.includes("ALLOW_USER_AUTH")) throw new Error("The browser client must enable choice-based USER_AUTH.");
for (const flow of ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_USER_SRP_AUTH", "ALLOW_ADMIN_USER_PASSWORD_AUTH"]) {
  if (userPoolClient.includes(flow)) throw new Error(`The browser client must not enable ${flow}.`);
}
const managedLoginBranding = source.slice(source.indexOf("  ManagedLoginBranding:\n"), source.indexOf("  ApiAuthorizer:\n"));
if (!managedLoginBranding.includes("DependsOn: UserPoolDomain")) throw new Error("Managed login branding must wait for the version-2 user pool domain.");
if (!managedLoginBranding.includes("UserPoolId: !Ref UserPool") || !managedLoginBranding.includes("ClientId: !Ref UserPoolClient")) throw new Error("Managed login branding must be assigned to the launcher browser client.");
if (!managedLoginBranding.includes("UseCognitoProvidedValues: true")) throw new Error("Managed login branding must apply Cognito's default style.");
process.stdout.write("CloudFormation appliance invariants validated.\n");
