import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import enSettings from "@/shared/i18n/locales/en/settings.json";
import { TelemetryConsentRow } from "../TelemetryConsentRow";
import { useTelemetryConsentStore } from "@/shared/telemetry/consent";

const ensureLoaded = vi.fn();
const updateEnabled = vi.fn();
const enforced = vi.fn(() => false);
const toastError = vi.fn();
// The reactive `telemetry` capability: false in a build compiled with
// telemetry off, or once runtime config answers with the toggle disabled.
let telemetryAvailable = true;

vi.mock("@/shared/profile/capabilities", () => ({
  useProfileCapability: (capability: string) =>
    capability === "telemetry" ? telemetryAvailable : true,
}));

// The consent module is mocked at its boundary — the row's contract is what
// it renders from the store and which consent calls it makes, not the store's
// own load/persist behavior (consent.test.ts covers that). The store itself
// stays a real zustand store so `setState` drives renders as in production.
vi.mock("@/shared/telemetry/consent", async () => {
  const { create } = await import("zustand");
  return {
    useTelemetryConsentStore: create(() => ({
      loaded: false,
      enabled: false,
    })),
    ensureTelemetryConsentLoaded: (...args: unknown[]) => ensureLoaded(...args),
    updateTelemetryEnabled: (...args: unknown[]) =>
      updateEnabled(...args) as Promise<void>,
    telemetryConsentEnforced: () => enforced(),
  };
});

vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}));

describe("TelemetryConsentRow", () => {
  beforeEach(() => {
    ensureLoaded.mockClear();
    updateEnabled.mockReset().mockResolvedValue(undefined);
    enforced.mockReturnValue(false);
    telemetryAvailable = true;
    toastError.mockClear();
    useTelemetryConsentStore.setState({ loaded: true, enabled: false });
  });

  it("renders the toggle off by default and kicks the persisted read", () => {
    renderWithProviders(<TelemetryConsentRow />);

    expect(
      screen.getByText(enSettings.privacy.telemetry.label),
    ).toBeInTheDocument();
    const toggle = screen.getByRole("switch", {
      name: enSettings.privacy.telemetry.label,
    });
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeEnabled();
    expect(ensureLoaded).toHaveBeenCalled();
  });

  it("keeps the toggle disabled until the persisted setting has loaded", () => {
    useTelemetryConsentStore.setState({ loaded: false, enabled: false });
    renderWithProviders(<TelemetryConsentRow />);

    expect(
      screen.getByRole("switch", {
        name: enSettings.privacy.telemetry.label,
      }),
    ).toBeDisabled();
  });

  it("reflects an enabled persisted setting", () => {
    useTelemetryConsentStore.setState({ loaded: true, enabled: true });
    renderWithProviders(<TelemetryConsentRow />);

    expect(
      screen.getByRole("switch", {
        name: enSettings.privacy.telemetry.label,
      }),
    ).toBeChecked();
  });

  it("persists an opt-in through the consent store", async () => {
    renderWithProviders(<TelemetryConsentRow />);

    await userEvent.click(
      screen.getByRole("switch", {
        name: enSettings.privacy.telemetry.label,
      }),
    );

    expect(updateEnabled).toHaveBeenCalledWith(true);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("surfaces a failed write instead of showing an unpersisted state", async () => {
    updateEnabled.mockRejectedValue(new Error("read-only disk"));
    const consoleWarn = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    renderWithProviders(<TelemetryConsentRow />);

    await userEvent.click(
      screen.getByRole("switch", {
        name: enSettings.privacy.telemetry.label,
      }),
    );

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        enSettings.privacy.telemetry.saveError,
      );
    });
    // The switch renders the store, which the failed write never touched.
    expect(
      screen.getByRole("switch", {
        name: enSettings.privacy.telemetry.label,
      }),
    ).not.toBeChecked();
    consoleWarn.mockRestore();
  });

  it("presents the usage-data details from the learn-more link", async () => {
    renderWithProviders(<TelemetryConsentRow />);

    await userEvent.click(
      screen.getByRole("button", {
        name: enSettings.privacy.telemetry.learnMore,
      }),
    );

    expect(
      screen.getByRole("dialog", {
        name: enSettings.privacy.telemetry.usageDialog.title,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(enSettings.privacy.telemetry.usageDialog.collectTitle),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        enSettings.privacy.telemetry.usageDialog.notCollectTitle,
      ),
    ).toBeInTheDocument();
  });

  it("renders nothing in enforced builds", () => {
    enforced.mockReturnValue(true);
    const { container } = renderWithProviders(<TelemetryConsentRow />);

    expect(container).toBeEmptyDOMElement();
    expect(ensureLoaded).not.toHaveBeenCalled();
  });

  it("renders nothing without the telemetry capability", () => {
    telemetryAvailable = false;
    const { container } = renderWithProviders(<TelemetryConsentRow />);

    expect(container).toBeEmptyDOMElement();
    expect(ensureLoaded).not.toHaveBeenCalled();
  });

  // Hiding the row is a display decision, not a consent decision: nothing is
  // persisted on the way out, so the choice is intact if the capability
  // returns (a runtime config that re-enables the toggle, say).
  it("keeps the persisted choice while the capability is unavailable", () => {
    useTelemetryConsentStore.setState({ loaded: true, enabled: true });
    telemetryAvailable = false;
    const { container, rerender } = renderWithProviders(
      <TelemetryConsentRow />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(updateEnabled).not.toHaveBeenCalled();

    telemetryAvailable = true;
    rerender(<TelemetryConsentRow />);

    const toggle = screen.getByRole("switch", {
      name: enSettings.privacy.telemetry.label,
    });
    expect(toggle).toBeChecked();
    expect(toggle).toBeEnabled();
    expect(ensureLoaded).toHaveBeenCalled();
  });
});
