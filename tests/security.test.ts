import { assertOwnerClaims } from "../src/cloud/authorization";
import { redact, StreamingSanitizer } from "../src/runner/command";
import { assertSafeEntry } from "../src/runner/release";

describe("security boundaries", () => {
  it("accepts only the configured verified owner", () => {
    expect(() => assertOwnerClaims({ email: "owner@example.com", email_verified: "true" }, "owner@example.com")).not.toThrow();
    expect(() => assertOwnerClaims({ email: "other@example.com", email_verified: "true" }, "owner@example.com")).toThrow(/owner/);
    expect(() => assertOwnerClaims({ email: "owner@example.com", email_verified: "false" }, "owner@example.com")).toThrow(/owner/);
  });

  it("redacts known secrets and credential-shaped output", () => {
    expect(redact("token=super-secret AWS_SECRET_ACCESS_KEY=abc", ["super-secret"])).toBe("token=[REDACTED] AWS_SECRET_ACCESS_KEY=[REDACTED]");
    const sanitizer = new StreamingSanitizer(["split-secret"]);
    expect(sanitizer.append("value=split-")).toBe("");
    expect(sanitizer.append("secret\n")).toBe("value=[REDACTED]\n");
  });

  it("rejects unsafe archive paths", () => {
    expect(() => assertSafeEntry("src/index.ts")).not.toThrow();
    expect(() => assertSafeEntry("../../etc/passwd")).toThrow(/unsafe path/);
    expect(() => assertSafeEntry("..\\..\\windows\\secret")).toThrow(/unsafe path/);
  });
});
