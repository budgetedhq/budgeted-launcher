import { defineConfig } from "tsup";

const shared = {
  format: "cjs" as const,
  platform: "node" as const,
  target: "node24",
  outDir: "dist/cloud",
  sourcemap: true,
  minify: true,
  splitting: false,
  clean: false,
  noExternal: [/^@aws-sdk\//, "smol-toml", "tar", "zod"],
};

export default defineConfig([
  { ...shared, entry: { api: "src/cloud/api-handler.ts", reconciler: "src/cloud/reconciler-handler.ts", artifacts: "src/cloud/artifact-handler.ts" } },
  { ...shared, entry: { runner: "src/runner/index.ts" } },
]);
