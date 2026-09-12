import type { EventBridgeEvent, ScheduledEvent } from "aws-lambda";
import { BatchGetBuildsCommand, CodeBuildClient } from "@aws-sdk/client-codebuild";
import { DeleteParametersCommand, DescribeParametersCommand, SSMClient } from "@aws-sdk/client-ssm";

import { getEnvironment } from "./environment";
import { StateStore } from "./store";

const env = getEnvironment();
const store = new StateStore(env.tableName);
const codeBuild = new CodeBuildClient({});
const ssm = new SSMClient({});

type BuildEvent = EventBridgeEvent<"CodeBuild Build State Change", { "build-id": string; "build-status": string }>;

export async function handler(event: BuildEvent | ScheduledEvent) {
  if (event["detail-type"] === "Scheduled Event") return cleanupStaleSecrets();
  const detail = (event as BuildEvent).detail;
  const result = await codeBuild.send(new BatchGetBuildsCommand({ ids: [detail["build-id"]] }));
  const build = result.builds?.[0];
  const operationId = build?.environment?.environmentVariables?.find((item) => item.name === "OPERATION_ID")?.value;
  if (!operationId) return;
  const job = await store.getRunnerJob(operationId);
  if (!job) return;
  await deleteParameters(Object.values(job.secretParameterNames ?? {}));
  await store.updateOperation(operationId, "SET logStreamName = :stream", { ":stream": build?.logs?.streamName ?? null });
  if (["succeeded", "failed", "cancelled", "interrupted"].includes(job.status)) return;
  if (detail["build-status"] === "SUCCEEDED") await store.completeOperation(operationId, "succeeded");
  else if (job.cancellationRequestedAt || detail["build-status"] === "STOPPED") await store.completeOperation(operationId, "cancelled", "Operation cancelled.");
  else await store.completeOperation(operationId, ["deploy", "redeploy", "rollback", "remove"].includes(job.action) ? "interrupted" : "failed", `CodeBuild ended with ${detail["build-status"]}.`);
}

async function cleanupStaleSecrets() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1_000;
  let nextToken: string | undefined;
  do {
    const page = await ssm.send(new DescribeParametersCommand({
      ParameterFilters: [{ Key: "Name", Option: "BeginsWith", Values: [env.operationParameterPrefix] }],
      NextToken: nextToken,
    }));
    const names = (page.Parameters ?? []).filter((item) => item.Name && item.LastModifiedDate && item.LastModifiedDate.getTime() < cutoff).map((item) => item.Name!);
    await deleteParameters(names);
    nextToken = page.NextToken;
  } while (nextToken);
}

async function deleteParameters(names: string[]) {
  for (let index = 0; index < names.length; index += 10) await ssm.send(new DeleteParametersCommand({ Names: names.slice(index, index + 10) }));
}
