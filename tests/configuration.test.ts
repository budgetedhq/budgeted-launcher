import { parse } from "smol-toml";

import { createConfigurationDocument, createConfigurationFingerprint, createSstSecrets, generateBudgetedToml, parseBudgetedToml, validateSecrets } from "../src/core/configuration";
import { DEFAULT_CONFIGURATION, liveSecretsSchema } from "../src/shared/contracts";

describe("Budgeted configuration", () => {
  it("round trips structured fields through canonical TOML", () => {
    const input = {
      ...DEFAULT_CONFIGURATION,
      appName: "budgeted-family",
      amazonOrders: { enabled: true, apiUrl: "https://orders.example.com" },
      domain: { mode: "route53" as const, name: "budget.example.com", zoneId: "Z123" },
      venmoEmail: { enabled: true as const, recipient: "venmo@example.com", allowedForwarders: ["forwarder@example.com"], dns: "aws" as const, route53ZoneId: "ZVENMO" },
    };
    const toml = generateBudgetedToml(input);
    const output = parse(toml) as Record<string, any>;
    expect(output.app).toEqual({ name: "budgeted-family", productionStage: "production" });
    expect(output.stages.production.webDomain).toEqual({ name: "budget.example.com", dns: "aws", route53ZoneId: "Z123" });
    expect(parseBudgetedToml(toml, input)).toMatchObject(input);
  });

  it("keeps exact valid TOML separate from canonical structured saves", () => {
    const exact = `${generateBudgetedToml(DEFAULT_CONFIGURATION)}\n# owner comment\n`;
    const parsed = parseBudgetedToml(exact);
    expect(exact).toContain("# owner comment");
    expect(createConfigurationDocument(parsed, 4)).toMatchObject({ source: "structured", revision: 4 });
  });

  it("rejects fields outside the launcher configuration schema", () => {
    expect(() => parseBudgetedToml(`${generateBudgetedToml(DEFAULT_CONFIGURATION)}\n[unexpected]\nvalue = true\n`)).toThrow(/Unsupported TOML field/);
  });

  it("fingerprints account, region, release commit, app, stage, and TOML deterministically", () => {
    const configuration = createConfigurationDocument(DEFAULT_CONFIGURATION);
    const input = { awsAccountId: "123456789012", awsRegion: "us-east-1", releaseCommit: "a".repeat(40), configuration };
    expect(createConfigurationFingerprint(input)).toBe(createConfigurationFingerprint(input));
    expect(createConfigurationFingerprint({ ...input, awsRegion: "us-west-2" })).not.toBe(createConfigurationFingerprint(input));
  });

  it("requires only credentials for enabled integrations", () => {
    expect(() => validateSecrets(DEFAULT_CONFIGURATION, {})).not.toThrow();
    const plaid = { ...DEFAULT_CONFIGURATION, plaid: { enabled: true, environment: "sandbox" as const } };
    expect(() => validateSecrets(plaid, {})).toThrow(/Plaid client ID, Plaid secret/);
    expect([...createSstSecrets(plaid, { plaidClientId: "client", plaidSecret: "secret" }, "auth").keys()]).toEqual(["AuthSecret", "PlaidClientId", "PlaidSecret"]);
    expect(liveSecretsSchema.safeParse({ adminPassword: "eight888" }).success).toBe(true);
  });
});
