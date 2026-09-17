import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { App } from "../src/renderer/App";

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
});
