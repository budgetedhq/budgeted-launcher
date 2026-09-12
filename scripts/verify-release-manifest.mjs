import { createHash, createPublicKey, createVerify } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const output = join(root, "dist", "artifacts");
const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
const { signature, ...unsigned } = manifest;
const key = createPublicKey({ key: Buffer.from(required("LAUNCHER_MANIFEST_PUBLIC_KEY"), "base64"), format: "der", type: "spki" });
const verifier = createVerify("SHA256");
verifier.update(JSON.stringify(unsigned));
verifier.end();
if (!verifier.verify(key, signature, "base64")) throw new Error("Release manifest signature verification failed.");
const files = {
  templateSha256: "template.yaml", apiSha256: "lambda/api.zip", reconcilerSha256: "lambda/reconciler.zip",
  artifactsSha256: "lambda/artifacts.zip", runnerSha256: "codebuild/runner.zip", rendererSha256: "renderer.zip",
};
for (const [field, file] of Object.entries(files)) {
  const digest = createHash("sha256").update(await readFile(join(output, file))).digest("hex");
  if (digest !== manifest[field]) throw new Error(`${file} failed checksum verification.`);
}
process.stdout.write("Release signature and artifact hashes verified.\n");
function required(name) { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}.`); return value; }
