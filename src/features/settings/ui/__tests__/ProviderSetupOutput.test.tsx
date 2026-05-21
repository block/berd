import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { ProviderSetupOutput } from "../ProviderSetupOutput";

describe("ProviderSetupOutput", () => {
  const writeText = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    writeText.mockResolvedValue(undefined);
  });

  it("promotes device codes out of low-priority setup output", () => {
    renderWithProviders(
      <ProviderSetupOutput
        lines={[
          { id: 1, text: "Open https://github.com/login/device" },
          { id: 2, text: "Enter device code ABCD-1234 to continue." },
        ]}
      />,
    );

    expect(screen.getByText("Device code")).toBeInTheDocument();
    expect(screen.getByText("ABCD-1234")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy device code" }),
    ).toBeInTheDocument();
  });

  it("copies the promoted device code", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderWithProviders(
      <ProviderSetupOutput
        lines={[{ id: 1, text: "Copy device code WXYZ-9876." }]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Copy device code" }));

    expect(writeText).toHaveBeenCalledWith("WXYZ-9876");
  });

  it("detects a device code when instructions and code are separate lines", () => {
    renderWithProviders(
      <ProviderSetupOutput
        lines={[
          { id: 1, text: "Enter the device code in your browser." },
          { id: 2, text: "LMNO-2468" },
        ]}
      />,
    );

    expect(screen.getAllByText("LMNO-2468")).toHaveLength(2);
  });

  it("uses readable semantic text tokens for raw setup output", () => {
    const { container } = renderWithProviders(
      <ProviderSetupOutput lines={[{ id: 1, text: "Waiting for sign-in" }]} />,
    );

    const output = container.querySelector(".font-mono");
    expect(output).toHaveClass("bg-muted");
    expect(output).toHaveClass("text-muted-foreground");
    expect(output).not.toHaveClass("text-xxs");
  });
});
