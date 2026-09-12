import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = packageJson.version;
const tag = process.env.RELEASE_TAG ?? process.argv[2];
const stableSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

if (typeof version !== "string" || !stableSemver.test(version)) {
  throw new Error(`package.json version must be stable semver; received ${JSON.stringify(version)}.`);
}
if (!tag) throw new Error("RELEASE_TAG is required.");
if (tag !== `v${version}`) {
  throw new Error(`Release tag ${tag} does not match package.json version ${version}; expected v${version}.`);
}

process.stdout.write(`Release tag ${tag} matches package.json.\n`);
