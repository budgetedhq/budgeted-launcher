import { createPrivateKey, createSign } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const output = join(root, "dist", "artifacts");
const checksums = JSON.parse(await readFile(join(output, "checksums.json"), "utf8"));
const region = required("AWS_REGION");
const privateKey = createPrivateKey(Buffer.from(required("LAUNCHER_MANIFEST_PRIVATE_KEY"), "base64").toString("utf8"));
const unsigned = {
  version: checksums.version,
  notes: process.env.LAUNCHER_RELEASE_NOTES ?? `Budgeted Launcher ${checksums.version}`,
  publishedAt: new Date().toISOString(),
  supportedBudgetedRange: process.env.SUPPORTED_BUDGETED_RANGE ?? ">=0.1.0 <1.0.0",
  templateUrl: `https://budgetedhq-budgeted-launcher-${region}.s3.${region}.amazonaws.com/releases/${checksums.version}/template.yaml`,
  templateSha256: checksums.templateSha256,
  apiSha256: checksums.apiSha256,
  reconcilerSha256: checksums.reconcilerSha256,
  artifactsSha256: checksums.artifactsSha256,
  runnerSha256: checksums.runnerSha256,
  rendererSha256: checksums.rendererSha256,
};
const signer = createSign("SHA256");
signer.update(JSON.stringify(unsigned));
signer.end();
await writeFile(join(output, "manifest.json"), JSON.stringify({ ...unsigned, signature: signer.sign(privateKey, "base64") }, null, 2));

function required(name) { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}.`); return value; }
