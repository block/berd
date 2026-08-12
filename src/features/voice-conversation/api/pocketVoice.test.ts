import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import {
  getPocketVoiceStatus,
  installVoiceModel,
  listenToPocketVoiceStatus,
  previewPocketVoice,
  removeVoiceModel,
  selectPocketVoice,
  setPocketPlaybackSpeed,
  speakPocketVoice,
  stopPocketVoice,
} from "./pocketVoice";

describe("Pocket voice API", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
  });

  it("uses the native install and selection commands", async () => {
    const status = { installed: false, voices: [] };
    mocks.invoke.mockResolvedValue(status);

    await expect(getPocketVoiceStatus()).resolves.toBe(status);
    await expect(installVoiceModel("parakeet")).resolves.toBe(status);
    await expect(selectPocketVoice("mary")).resolves.toBe(status);
    await expect(setPocketPlaybackSpeed(2)).resolves.toBe(status);
    await expect(previewPocketVoice("mary")).resolves.toBe(status);
    await expect(speakPocketVoice("Hello")).resolves.toBe(status);
    await expect(stopPocketVoice()).resolves.toBe(status);
    await expect(removeVoiceModel("pocket")).resolves.toBe(status);

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "get_pocket_voice_status");
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "install_voice_model", {
      model: "parakeet",
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, "select_pocket_voice", {
      voiceId: "mary",
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(
      4,
      "set_pocket_playback_speed",
      { speed: 2 },
    );
    expect(mocks.invoke).toHaveBeenNthCalledWith(5, "preview_pocket_voice", {
      voiceId: "mary",
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(6, "speak_pocket_voice", {
      text: "Hello",
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(7, "stop_pocket_voice");
    expect(mocks.invoke).toHaveBeenNthCalledWith(8, "remove_voice_model", {
      model: "pocket",
    });
  });

  it("unwraps download progress events", async () => {
    const callback = vi.fn();
    const status = {
      installed: false,
      downloading: true,
      downloadedBytes: 42,
      totalBytes: 100,
    };
    mocks.listen.mockImplementation(async (_event, handler) => {
      handler({ payload: status });
      return vi.fn();
    });

    await listenToPocketVoiceStatus(callback);
    expect(callback).toHaveBeenCalledWith(status);
  });
});
