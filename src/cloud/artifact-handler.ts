import type { CloudFormationCustomResourceEvent, CloudFormationCustomResourceResponse } from "aws-lambda";
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, ListObjectVersionsCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const s3 = new S3Client({});

export async function handler(event: CloudFormationCustomResourceEvent) {
  const properties = event.ResourceProperties as Record<string, string>;
  try {
    if (event.RequestType === "Delete") await emptyBucket(properties.DestinationBucket);
    else await publish(properties);
    await respond(event, "SUCCESS", {}, "BudgetedLauncherArtifacts");
  } catch (error) {
    await respond(event, "FAILED", { Error: error instanceof Error ? error.message.slice(0, 1_000) : "Artifact installation failed." }, "BudgetedLauncherArtifacts");
  }
}

async function publish(properties: Record<string, string>) {
  await emptyBucket(properties.DestinationBucket);
  const prefix = `releases/${properties.Version}/renderer/`;
  let continuationToken: string | undefined;
  let copied = 0;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: properties.SourceBucket, Prefix: prefix, ContinuationToken: continuationToken }));
    for (const item of page.Contents ?? []) {
      if (!item.Key || item.Key.endsWith("/")) continue;
      const source = await s3.send(new GetObjectCommand({ Bucket: properties.SourceBucket, Key: item.Key }));
      if (!source.Body) throw new Error(`Published asset ${item.Key} is empty.`);
      await s3.send(new PutObjectCommand({
        Bucket: properties.DestinationBucket, Key: item.Key.slice(prefix.length), Body: await source.Body?.transformToByteArray(),
        ContentType: contentType(item.Key), CacheControl: item.Key.endsWith("index.html") ? "no-store" : "public,max-age=31536000,immutable",
      }));
      copied += 1;
    }
    continuationToken = page.NextContinuationToken;
  } while (continuationToken);
  if (!copied) throw new Error("The published renderer has no files.");
  await s3.send(new PutObjectCommand({
    Bucket: properties.DestinationBucket, Key: "config.json", ContentType: "application/json", CacheControl: "no-store",
    Body: JSON.stringify({
      apiUrl: properties.LauncherUrl, awsRegion: properties.AwsRegion,
      userPoolId: properties.UserPoolId, userPoolClientId: properties.UserPoolClientId,
      cognitoDomain: properties.CognitoDomain, callbackUrl: properties.LauncherUrl, launcherVersion: properties.Version,
    }),
  }));
  const runnerKey = `releases/${properties.Version}/codebuild/runner.zip`;
  const runner = await s3.send(new GetObjectCommand({ Bucket: properties.SourceBucket, Key: runnerKey }));
  if (!runner.Body) throw new Error("The published runner bundle is empty.");
  await s3.send(new PutObjectCommand({
    Bucket: properties.DestinationBucket, Key: `runner/${properties.Version}/runner.zip`,
    Body: await runner.Body?.transformToByteArray(), ContentType: "application/zip", CacheControl: "public,max-age=31536000,immutable",
  }));
}

async function emptyBucket(bucket: string) {
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    const page = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker }));
    const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].flatMap((item) => item.Key && item.VersionId ? [{ Key: item.Key, VersionId: item.VersionId }] : []);
    if (objects.length) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
    keyMarker = page.NextKeyMarker;
    versionIdMarker = page.NextVersionIdMarker;
  } while (keyMarker);
}

async function respond(event: CloudFormationCustomResourceEvent, status: "SUCCESS" | "FAILED", data: Record<string, string>, physicalResourceId: string) {
  const body: CloudFormationCustomResourceResponse = {
    Status: status, Reason: data.Error ?? `See CloudWatch Log Stream: ${event.RequestId}`,
    PhysicalResourceId: physicalResourceId, StackId: event.StackId, RequestId: event.RequestId, LogicalResourceId: event.LogicalResourceId,
    NoEcho: false, Data: data,
  };
  const response = await fetch(event.ResponseURL, { method: "PUT", headers: { "content-type": "" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`CloudFormation response failed (${response.status}).`);
}

function contentType(key: string) {
  if (key.endsWith(".html")) return "text/html; charset=utf-8";
  if (key.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (key.endsWith(".css")) return "text/css; charset=utf-8";
  if (key.endsWith(".svg")) return "image/svg+xml";
  if (key.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}
