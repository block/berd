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

vi.mock("@/features/settings/lib/notificationPrefs", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/features/settings/lib/notificationPrefs")
    >();
  return {
    ...actual,
    getNotificationPrefs: (...args: unknown[]) => getPrefs(...args),
    setNotificationPrefs: (...args: unknown[]) => setPrefs(...args),
  };
});

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
      toastDurationSeconds: 8,
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
      toastDurationSeconds: 8,
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

  it("renders the notification duration control when enabled", () => {
    renderWithProviders(<NotificationSettings />);
    expect(
      screen.getByText(enSettings.notifications.toastDuration.label),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("slider", {
        name: enSettings.notifications.toastDuration.label,
      }),
    ).toBeInTheDocument();
  });

  it("announces the time unit on the duration slider's accessible value", () => {
    renderWithProviders(<NotificationSettings />);
    const slider = screen.getByRole("slider", {
      name: enSettings.notifications.toastDuration.label,
    });
    expect(slider).toHaveAttribute(
      "aria-valuetext",
      enSettings.notifications.toastDuration.seconds_other.replace(
        "{{count}}",
        "8",
      ),
    );
    expect(slider).toHaveAttribute("aria-describedby");
  });

  it("hides the duration control (scoped to in-app) when in-app notifications are disabled", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationSettings />);

    expect(
      screen.getByText(enSettings.notifications.toastDuration.label),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("switch", {
        name: enSettings.notifications.inApp.label,
      }),
    );

    expect(
      screen.queryByText(enSettings.notifications.toastDuration.label),
    ).not.toBeInTheDocument();
  });

  it("restores the last timed duration (not the slider minimum) when leaving never-dismiss", async () => {
    const user = userEvent.setup();
    getPrefs.mockReturnValue({
      enabled: true,
      inApp: true,
      desktop: true,
      inAppSound: "berd-sounds-4.mp3",
      desktopSound: "berd-sounds-4.mp3",
      toastDurationSeconds: 25,
    });
    renderWithProviders(<NotificationSettings />);

    await user.click(
      screen.getByRole("button", {
        name: enSettings.notifications.toastDuration.neverDismiss,
      }),
    );
    expect(setPrefs).toHaveBeenCalledWith({ toastDurationSeconds: 0 });

    await user.click(
      screen.getByRole("button", {
        name: enSettings.notifications.toastDuration.autoDismiss,
      }),
    );
    expect(setPrefs).toHaveBeenLastCalledWith({ toastDurationSeconds: 25 });
    expect(
      screen.getByText(
        enSettings.notifications.toastDuration.seconds_other.replace(
          "{{count}}",
          "25",
        ),
      ),
    ).toBeInTheDocument();
  });

  it("hides the timed slider while never-dismiss is active", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationSettings />);

    expect(
      screen.getByRole("slider", {
        name: enSettings.notifications.toastDuration.label,
      }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", {
        name: enSettings.notifications.toastDuration.neverDismiss,
      }),
    );

    expect(
      screen.queryByRole("slider", {
        name: enSettings.notifications.toastDuration.label,
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(enSettings.notifications.toastDuration.never),
    ).toBeInTheDocument();
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
