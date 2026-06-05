import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { NotificationSettings } from "../NotificationSettings";
import enSettings from "@/shared/i18n/locales/en/settings.json";

const getPrefs = vi.fn();
const setPrefs = vi.fn();

vi.mock("@/features/settings/lib/notificationPrefs", () => ({
  getNotificationPrefs: (...args: unknown[]) => getPrefs(...args),
  setNotificationPrefs: (...args: unknown[]) => setPrefs(...args),
}));

describe("NotificationSettings", () => {
  beforeEach(() => {
    getPrefs.mockReturnValue({ enabled: true, inApp: true, desktop: true });
    setPrefs.mockClear();
  });

  it("renders the master toggle", () => {
    renderWithProviders(<NotificationSettings />);
    expect(
      screen.getByText(enSettings.notifications.enabled.label),
    ).toBeInTheDocument();
  });

  it("shows sub-toggles when enabled is true", () => {
    renderWithProviders(<NotificationSettings />);
    expect(
      screen.getByText(enSettings.notifications.inApp.label),
    ).toBeInTheDocument();
    expect(
      screen.getByText(enSettings.notifications.desktop.label),
    ).toBeInTheDocument();
  });

  it("hides sub-toggles when enabled is false", () => {
    getPrefs.mockReturnValue({ enabled: false, inApp: true, desktop: true });
    renderWithProviders(<NotificationSettings />);
    expect(
      screen.queryByText(enSettings.notifications.inApp.label),
    ).not.toBeInTheDocument();
  });

  it("calls setNotificationPrefs with enabled:false when master toggle is turned off", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationSettings />);
    const masterSwitch = screen.getByRole("switch", {
      name: enSettings.notifications.enabled.label,
    });
    await user.click(masterSwitch);
    expect(setPrefs).toHaveBeenCalledWith({ enabled: false });
  });

  it("calls setNotificationPrefs with inApp:false when in-app toggle is turned off", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationSettings />);
    const inAppSwitch = screen.getByRole("switch", {
      name: enSettings.notifications.inApp.label,
    });
    await user.click(inAppSwitch);
    expect(setPrefs).toHaveBeenCalledWith({ inApp: false });
  });
});
