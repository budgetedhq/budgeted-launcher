import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = new URL("..", import.meta.url).pathname;
const output = join(root, "dist", "artifacts");
const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
const publicKey = process.env.LAUNCHER_MANIFEST_PUBLIC_KEY ?? "UNPUBLISHED";
if (process.env.REQUIRE_PUBLISHABLE_ARTIFACTS === "true" && (!publicKey || publicKey === "UNPUBLISHED")) {
  throw new Error("LAUNCHER_MANIFEST_PUBLIC_KEY is required for publishable artifacts.");
}
await rm(output, { recursive: true, force: true });
await mkdir(join(output, "lambda"), { recursive: true });
await mkdir(join(output, "codebuild"), { recursive: true });
await cp(join(root, "dist", "renderer"), join(output, "renderer"), { recursive: true });

for (const name of ["api", "reconciler", "artifacts"]) await zipFile(join(root, "dist", "cloud", `${name}.cjs`), join(output, "lambda", `${name}.zip`));
await zipFile(join(root, "dist", "cloud", "runner.cjs"), join(output, "codebuild", "runner.zip"));
await exec("zip", ["-q", "-r", join(output, "renderer.zip"), "."], { cwd: join(output, "renderer") });

const template = (await readFile(join(root, "infra", "launcher.yaml"), "utf8"))
  .replaceAll("__LAUNCHER_VERSION__", version)
  .replaceAll("__MANIFEST_PUBLIC_KEY__", publicKey);
await writeFile(join(output, "template.yaml"), template);
await writeFile(join(output, "checksums.json"), JSON.stringify({
  version,
  apiSha256: await sha256(join(output, "lambda", "api.zip")),
  reconcilerSha256: await sha256(join(output, "lambda", "reconciler.zip")),
  artifactsSha256: await sha256(join(output, "lambda", "artifacts.zip")),
  runnerSha256: await sha256(join(output, "codebuild", "runner.zip")),
  rendererSha256: await sha256(join(output, "renderer.zip")),
  templateSha256: await sha256(join(output, "template.yaml")),
}, null, 2));

async function zipFile(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await rm(destination, { force: true });
  await exec("zip", ["-q", "-j", destination, source]);
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
