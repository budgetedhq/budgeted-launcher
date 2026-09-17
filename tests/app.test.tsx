import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { App, OperationBanner } from "../src/renderer/App";
import type { CloudOperation } from "../src/shared/contracts";

describe("browser launcher", () => {
  it("shows the five-step serverless setup and immutable AWS properties", async () => {
    const user = userEvent.setup();
    render(<App authenticated />);
    expect(await screen.findByRole("heading", { name: "Budgeted Launcher" })).toBeInTheDocument();
    expect(await screen.findByText("123456789012")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Integrations and administrator/ })).toBeInTheDocument();
    expect(screen.queryByText(/AWS login|Keychain|local disk/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Start configuration" }));
    expect(screen.queryByLabelText("Production stage")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Domain type")).toHaveDisplayValue("AWS Generated URL");
    expect(screen.getByRole("option", { name: "Custom Domain Hosted by AWS" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Custom Domain Hosted Elsewhere" })).toBeInTheDocument();
    expect(screen.getByText("Advanced settings")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(await screen.findByRole("heading", { name: "Integrations and administrator" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Administrator email"), "owner@example.com");
    await user.type(screen.getByLabelText(/Administrator password/), "short");
    await user.type(screen.getByLabelText("Confirm password"), "short");
    expect(screen.getByText("Use at least 8 characters.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save and continue" })).toBeDisabled();

    await user.type(screen.getByLabelText(/Administrator password/), "123");
    await user.type(screen.getByLabelText(/Confirm password/), "123");
    expect(screen.queryByText("Use at least 8 characters.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save and continue" })).toBeEnabled();
  });

  it("shows persistent running and failed operation feedback", async () => {
    const user = userEvent.setup();
    const operation: CloudOperation = {
      id: "977b1b90-cf3a-4a05-8979-c65b085b210e",
      action: "prepare",
      inputRevision: 1,
      fingerprint: "a".repeat(64),
      phase: "setting-secrets",
      status: "running",
      createdAt: new Date().toISOString(),
      expiresAt: Math.floor(Date.now() / 1_000) + 60,
      remoteStateUncertain: false,
    };
    const onDismiss = vi.fn();
    const view = render(<OperationBanner operation={operation} onDismiss={onDismiss} />);

    expect(screen.getByRole("status")).toHaveTextContent("Preparing release…");
    expect(screen.getByRole("status")).toHaveTextContent("The command is running and may take a few minutes to complete.");
    expect(view.container.querySelector(".spinner")).toBeInTheDocument();

    view.rerender(<OperationBanner operation={{ ...operation, status: "failed", phase: "failed", error: "SST could not configure the asset bucket." }} onDismiss={onDismiss} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Prepare release failed.");
    expect(screen.getByRole("alert")).toHaveTextContent("SST could not configure the asset bucket.");
    expect(screen.getByRole("alert")).toHaveTextContent("Review Console Output for details.");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
