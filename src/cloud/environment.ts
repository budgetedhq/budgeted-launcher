import { awsRegionSchema } from "../shared/contracts";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

export function getEnvironment() {
  const launcherVersion = required("LAUNCHER_VERSION");
  return {
    tableName: required("TABLE_NAME"),
    ownerEmail: required("OWNER_EMAIL"),
    awsAccountId: required("AWS_ACCOUNT_ID"),
    awsRegion: awsRegionSchema.parse(required("AWS_REGION")),
    launcherVersion,
    buildProjectName: required("BUILD_PROJECT_NAME"),
    operationParameterPrefix: required("OPERATION_PARAMETER_PREFIX"),
    operationLogGroup: required("OPERATION_LOG_GROUP"),
    stackName: required("STACK_NAME"),
    selfUpdateRoleArn: required("SELF_UPDATE_ROLE_ARN"),
    publisherBucket: required("PUBLISHER_BUCKET"),
    manifestKey: process.env.MANIFEST_KEY ?? "stable/manifest.json",
    installedManifestKey: `releases/${launcherVersion}/manifest.json`,
    manifestPublicKey: required("MANIFEST_PUBLIC_KEY"),
  };
}
