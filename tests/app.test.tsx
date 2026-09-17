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
  });
});
