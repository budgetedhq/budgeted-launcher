import { render, screen } from "@testing-library/react";

import { App } from "../src/renderer/App";

describe("browser launcher", () => {
  it("shows the five-step serverless setup and immutable AWS properties", async () => {
    render(<App authenticated />);
    expect(await screen.findByRole("heading", { name: "Budgeted Launcher" })).toBeInTheDocument();
    expect(await screen.findByText("123456789012")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Integrations and administrator/ })).toBeInTheDocument();
    expect(screen.queryByText(/AWS login|Keychain|local disk/i)).not.toBeInTheDocument();
  });
});
