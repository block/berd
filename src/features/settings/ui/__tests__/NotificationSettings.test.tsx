import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { NotificationSettings } from "../NotificationSettings";
import enSettings from "@/shared/i18n/locales/en/settings.json";
import {
  ASSISTIVE_UX_STORAGE_KEY,
  ASSISTIVE_UX_RULES,
} from "@/shared/assistive-ux/registry";

const getPrefs = vi.fn();
const setPrefs = vi.fn();
const audioPlay = vi.fn();

vi.mock("@/features/settings/lib/notificationPrefs", () => ({
  getNotificationPrefs: (...args: unknown[]) => getPrefs(...args),
  setNotificationPrefs: (...args: unknown[]) => setPrefs(...args),
}));

describe("NotificationSettings", () => {
  beforeEach(() => {
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
    audioPlay.mockResolvedValue(undefined);
    vi.stubGlobal(
      "Audio",
      vi.fn(function MockAudio() {
        return { play: audioPlay };
      }),
    );
    getPrefs.mockReturnValue({
      enabled: true,
      inApp: true,
      desktop: true,
      inAppSound: "berd-sounds-4.mp3",
      desktopSound: "berd-sounds-4.mp3",
    });
    setPrefs.mockClear();
    window.localStorage.removeItem(ASSISTIVE_UX_STORAGE_KEY);
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
    expect(
      screen.getAllByText(enSettings.notifications.inAppSound.label),
    ).toHaveLength(2);
  });

  it("hides sub-toggles when enabled is false", () => {
    getPrefs.mockReturnValue({
      enabled: false,
      inApp: true,
      desktop: true,
      inAppSound: "berd-sounds-4.mp3",
      desktopSound: "berd-sounds-4.mp3",
    });
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

  it("retires the change sound discover moment when notification settings change", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationSettings />);
    const masterSwitch = screen.getByRole("switch", {
      name: enSettings.notifications.enabled.label,
    });

    await user.click(masterSwitch);

    expect(
      JSON.parse(window.localStorage.getItem(ASSISTIVE_UX_STORAGE_KEY) ?? "{}")
        .moments[ASSISTIVE_UX_RULES.notificationsChangeSound.id].retiredReason,
    ).toBe("settingsChanged");
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

  it("calls setNotificationPrefs with silent when in-app sound is set to Silent", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationSettings />);
    await user.click(
      screen.getByRole("combobox", {
        name: enSettings.notifications.inAppSound.ariaLabel,
      }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: enSettings.notifications.sounds.silent,
      }),
    );
    expect(setPrefs).toHaveBeenCalledWith({ inAppSound: "silent" });
  });

  it("plays a sound preview without selecting that sound", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationSettings />);
    await user.click(
      screen.getByRole("combobox", {
        name: enSettings.notifications.inAppSound.ariaLabel,
      }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Preview Twinkle" }),
    );
    expect(audioPlay).toHaveBeenCalledTimes(1);
    expect(setPrefs).not.toHaveBeenCalled();
  });
});
