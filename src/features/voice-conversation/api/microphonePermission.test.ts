import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMicrophonePermissionStatus,
  openMicrophonePrivacySettings,
} from "./microphonePermission";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

describe("microphone permission API", () => {
  beforeEach(() => mocks.invoke.mockReset());

  it("uses the native status and settings commands", async () => {
    mocks.invoke
      .mockResolvedValueOnce("notDetermined")
      .mockResolvedValueOnce(undefined);

    await expect(getMicrophonePermissionStatus()).resolves.toBe(
      "notDetermined",
    );
    await expect(openMicrophonePrivacySettings()).resolves.toBeUndefined();

    expect(mocks.invoke).toHaveBeenNthCalledWith(
      1,
      "get_microphone_permission_status",
    );
    expect(mocks.invoke).toHaveBeenNthCalledWith(
      2,
      "open_microphone_privacy_settings",
    );
  });
});
