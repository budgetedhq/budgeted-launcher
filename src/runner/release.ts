import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import * as tar from "tar";

const ALLOWED_HOSTS = new Set(["api.github.com", "github.com", "codeload.github.com"]);
const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;

export async function downloadAndValidateRelease(input: { tag: string; commit: string; expectedDigest?: string; directory: string }) {
  const archive = join(input.directory, "release.tgz");
  const source = join(input.directory, "source");
  await mkdir(source, { recursive: true });
  const digest = await download(`https://api.github.com/repos/budgetedhq/budgeted/tarball/${input.commit}`, archive);
  if (input.expectedDigest && digest !== input.expectedDigest) throw new Error("The downloaded release does not match the prepared archive digest.");
  await tar.x({
    file: archive, cwd: source, strip: 1, preservePaths: false,
    filter: (entryPath, entry) => {
      assertSafeEntry(entryPath);
      if ("type" in entry && (entry.type === "SymbolicLink" || entry.type === "Link")) throw new Error("Release archives may not contain links.");
      return true;
    },
  });
  await validateFiles(source, input.tag);
  return { source, digest };
}

async function download(url: string, destination: string) {
  let current = new URL(url);
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (current.protocol !== "https:" || !ALLOWED_HOSTS.has(current.hostname)) throw new Error("Untrusted release download URL.");
    response = await fetch(current, { redirect: "manual", headers: { Accept: "application/vnd.github+json", "User-Agent": "Budgeted-Launcher" } });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location || redirects === 5) throw new Error("The release download used too many redirects.");
    current = new URL(location, current);
  }
  if (!response?.ok || !response.body) throw new Error(`Budgeted release download failed (${response?.status ?? "unknown"}).`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_ARCHIVE_BYTES) throw new Error("The Budgeted release archive is too large.");
  let bytes = 0;
  const hash = createHash("sha256");
  const readable = Readable.fromWeb(response.body as never);
  readable.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_ARCHIVE_BYTES) readable.destroy(new Error("The Budgeted release archive exceeded the size limit."));
    hash.update(chunk);
  });
  await pipeline(readable, createWriteStream(destination, { mode: 0o600 }));
  return hash.digest("hex");
}

async function validateFiles(directory: string, tag: string) {
  const required = ["package.json", "pnpm-lock.yaml", "sst.config.ts", "infra/config.ts", "scripts/seed-user.mjs"];
  await Promise.all(required.map((path) => readFile(join(directory, path))));
  const packageJson = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { name?: string; version?: string; packageManager?: string };
  if (packageJson.name !== "budgeted") throw new Error("The release package has an unexpected name.");
  if (packageJson.version !== tag.replace(/^v/, "")) throw new Error("The release tag and package version do not match.");
  if (!/^pnpm@11(?:\.|$)/.test(packageJson.packageManager ?? "")) throw new Error("The release requires an unsupported pnpm major version.");
}

export function assertSafeEntry(value: string) {
  const portable = value.replaceAll("\\", "/");
  const normalized = normalize(portable);
  if (portable.split("/").includes("..") || normalized.startsWith("..") || normalized.includes(`${sep}..${sep}`) || resolve("/safe", normalized).startsWith(`/safe${sep}`) === false) {
    throw new Error("The release archive contains an unsafe path.");
  }
}
