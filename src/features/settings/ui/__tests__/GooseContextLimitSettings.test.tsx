import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/shared/i18n";
import { GooseContextLimitSettings } from "../GooseContextLimitSettings";

const { useContextLimit, save } = vi.hoisted(() => ({
  useContextLimit: vi.fn(),
  save: vi.fn(),
}));
vi.mock("../../useGooseContextLimit", () => ({
  useGooseContextLimit: useContextLimit,
}));
vi.mock("@/shared/i18n", async () => ({
  ...(await vi.importActual<typeof import("@/shared/i18n")>("@/shared/i18n")),
  useLocaleFormatting: () => ({
    formatNumber: (value: number) =>
      new Intl.NumberFormat("en-US").format(value),
  }),
}));

describe("GooseContextLimitSettings", () => {
  beforeEach(() => {
    save.mockReset().mockImplementation(async (value: number) => value);
    useContextLimit.mockReset().mockReturnValue({
      contextLimit: 272_000,
      isHydrated: true,
      saveContextLimit: save,
    });
  });

  it("shows the default context budget", () => {
    render(<GooseContextLimitSettings />);
    expect(screen.getByText("272,000 tokens")).toBeInTheDocument();
    expect(
      screen.getByRole("spinbutton", { name: "Max context tokens" }),
    ).toHaveValue(272_000);
  });

  it("saves a committed slider change", async () => {
    const user = userEvent.setup();
    render(<GooseContextLimitSettings />);
    screen.getByRole("slider", { name: "Max context" }).focus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(save).toHaveBeenCalledWith(273_000));
  });

  it("supports exact values outside the slider range without clamping them", async () => {
    const user = userEvent.setup();
    useContextLimit.mockReturnValue({
      contextLimit: 2_000_000,
      isHydrated: true,
      saveContextLimit: save,
    });
    render(<GooseContextLimitSettings />);
    const input = screen.getByRole("spinbutton", {
      name: "Max context tokens",
    });
    expect(input).toHaveValue(2_000_000);
    expect(save).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, "512");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(512));
  });

  it.each([
    ["en", ""],
    ["en", "0"],
    ["en", "-1"],
    ["en", "1.5"],
    ["es", ""],
    ["es", "0"],
    ["es", "-1"],
    ["es", "1.5"],
  ])("explains invalid input in %s: %s", async (locale, value) => {
    await i18n.changeLanguage(locale);
    const user = userEvent.setup();
    render(<GooseContextLimitSettings />);
    const input = screen.getByRole("spinbutton");
    await user.clear(input);
    if (value) await user.type(input, value);
    expect(input).toHaveAttribute("aria-invalid", "true");
    const explanation = i18n.t("compaction.goose.contextLimit.invalid", {
      ns: "settings",
    });
    expect(screen.getByRole("alert")).toHaveTextContent(explanation);
    expect(input).toHaveAccessibleDescription(
      expect.stringContaining(explanation),
    );
    expect(screen.getByRole("button")).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
  });

  it("clears the validation explanation when the draft becomes valid", async () => {
    const user = userEvent.setup();
    render(<GooseContextLimitSettings />);
    const input = screen.getByRole("spinbutton");
    await user.clear(input);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await user.type(input, "450000");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "false");
    expect(input).not.toHaveAccessibleDescription(
      expect.stringContaining("Enter a positive whole number"),
    );
  });

  it("disables controls until config is loaded", () => {
    useContextLimit.mockReturnValue({
      contextLimit: 272_000,
      isHydrated: false,
      saveContextLimit: save,
    });
    render(<GooseContextLimitSettings />);
    expect(screen.getByRole("slider")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("spinbutton")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("rolls back the draft and shows a save error", async () => {
    const user = userEvent.setup();
    save.mockRejectedValue(new Error("write failed"));
    render(<GooseContextLimitSettings />);
    const input = screen.getByRole("spinbutton");
    await user.clear(input);
    await user.type(input, "450000");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn’t save your context limit",
    );
    expect(input).toHaveValue(272_000);
  });

  it("shows the effective environment override after saving", async () => {
    const user = userEvent.setup();
    save.mockResolvedValue(128_000);
    render(<GooseContextLimitSettings />);
    const input = screen.getByRole("spinbutton");
    await user.clear(input);
    await user.type(input, "450000");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(input).toHaveValue(128_000));
  });

  it("explains pending readback without presenting it as a failed save", () => {
    useContextLimit.mockReturnValue({
      contextLimit: 450_000,
      isHydrated: true,
      isReadbackPending: true,
      saveContextLimit: save,
    });
    render(<GooseContextLimitSettings />);
    expect(screen.getByRole("spinbutton")).toHaveValue(450_000);
    expect(screen.getByRole("status")).toHaveTextContent("was saved");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
