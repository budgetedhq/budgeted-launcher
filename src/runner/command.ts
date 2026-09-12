import { spawn } from "node:child_process";

export type CommandResult = { exitCode: number; stdout: string; stderr: string };

export class StreamingSanitizer {
  private pending = "";
  constructor(private readonly secrets: string[]) {}

  append(value: string) {
    this.pending += value;
    const lastBreak = Math.max(this.pending.lastIndexOf("\n"), this.pending.lastIndexOf("\r"));
    if (lastBreak < 0) return "";
    const output = redact(this.pending.slice(0, lastBreak + 1), this.secrets);
    this.pending = this.pending.slice(lastBreak + 1);
    return output;
  }

  flush() {
    const output = redact(this.pending, this.secrets);
    this.pending = "";
    return output;
  }
}

export function redact(value: string, secrets: string[]) {
  let output = value;
  for (const secret of secrets.filter((item) => item.length > 0).sort((a, b) => b.length - a.length)) output = output.split(secret).join("[REDACTED]");
  output = output.replace(/(AWS_(?:SECRET_ACCESS_KEY|SESSION_TOKEN|ACCESS_KEY_ID)\s*[=:]\s*)\S+/gi, "$1[REDACTED]");
  return output;
}

export async function runCommand(executable: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; stdin?: string; secrets?: string[] }): Promise<CommandResult> {
  const secrets = options.secrets ?? [];
  if (args.some((argument) => secrets.includes(argument))) throw new Error("A secret value cannot be placed in a process argument.");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd, shell: false, stdio: ["pipe", "pipe", "pipe"],
      env: { ...safeEnvironment(), ...options.env },
    });
    const sanitizer = new StreamingSanitizer(secrets);
    let stdout = "";
    let stderr = "";
    const append = (channel: "stdout" | "stderr", chunk: Buffer) => {
      const value = chunk.toString("utf8");
      if (channel === "stdout") stdout = `${stdout}${value}`.slice(-100_000);
      else stderr = `${stderr}${value}`.slice(-100_000);
      const safe = sanitizer.append(value);
      if (safe) process.stdout.write(safe);
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const final = sanitizer.flush();
      if (final) process.stdout.write(final);
      resolve({ exitCode: code ?? 1, stdout: redact(stdout, secrets), stderr: redact(stderr, secrets) });
    });
    child.stdin.end(options.stdin);
  });
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "CI", "CODEBUILD_BUILD_ID", "CODEBUILD_BUILD_ARN",
    "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN", "AWS_EC2_METADATA_DISABLED", "npm_config_cache", "XDG_CACHE_HOME",
  ];
  return Object.fromEntries(allowed.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]])) as NodeJS.ProcessEnv;
}
