import { formatApiError } from "../src/renderer/api";

describe("browser API errors", () => {
  it("shows field validation details instead of only the generic request message", () => {
    expect(formatApiError({
      code: "INVALID_REQUEST",
      message: "The request is invalid.",
      fieldErrors: {
        "configuration.appName": ["The application name must be budgeted or start with budgeted-."],
      },
      requestId: "D2OFVij-oAMEbyw=",
    })).toBe("The application name must be budgeted or start with budgeted-. (D2OFVij-oAMEbyw=)");
  });

  it("keeps the structured API message when no field details are present", () => {
    expect(formatApiError({
      code: "STALE_CONFIGURATION",
      message: "The configuration changed. Refresh and try again.",
      requestId: "request-123",
    })).toBe("The configuration changed. Refresh and try again. (request-123)");
  });

  it("does not expose malformed error responses", () => {
    expect(formatApiError("not an API error")).toBe("Launcher request failed.");
  });
});
