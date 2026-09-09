import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { resetAllVoiceBackendSettings } from "./voiceSettings";

describe("voice settings API", () => {
  beforeEach(() => mocks.invoke.mockReset());

  it("uses the transactional native reset command", async () => {
    mocks.invoke.mockResolvedValue(undefined);

    await expect(resetAllVoiceBackendSettings()).resolves.toBeUndefined();

    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "reset_all_voice_backend_settings",
    );
  });
});
