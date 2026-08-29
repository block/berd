import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import {
  appendPocketVoiceStream,
  finishPocketVoiceStream,
  flushPocketVoiceStream,
  getPocketVoiceStatus,
  installVoiceModel,
  listenToPocketVoiceStream,
  listenToPocketVoiceStatus,
  previewPocketVoice,
  removeVoiceModel,
  selectPocketVoice,
  setPocketPlaybackSpeed,
  speakPocketVoice,
  startPocketVoiceStream,
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

  it("uses the streaming utterance commands", async () => {
    mocks.invoke.mockResolvedValue(undefined);

    await startPocketVoiceStream(
      "session-1",
      4,
      7,
      "stream-1",
      "allowInterruptions",
      "more",
    );
    await appendPocketVoiceStream("stream-1", "Hello");
    await flushPocketVoiceStream("stream-1");
    await finishPocketVoiceStream("stream-1");

    expect(mocks.invoke).toHaveBeenNthCalledWith(
      1,
      "start_pocket_voice_stream",
      {
        sessionId: "session-1",
        expectedRevision: 4,
        speechId: 7,
        streamId: "stream-1",
        interruptionMode: "allowInterruptions",
        interruptionSensitivity: "more",
      },
    );
    expect(mocks.invoke).toHaveBeenNthCalledWith(
      2,
      "append_pocket_voice_stream",
      { streamId: "stream-1", text: "Hello" },
    );
    expect(mocks.invoke).toHaveBeenNthCalledWith(
      3,
      "flush_pocket_voice_stream",
      { streamId: "stream-1" },
    );
    expect(mocks.invoke).toHaveBeenNthCalledWith(
      4,
      "finish_pocket_voice_stream",
      { streamId: "stream-1" },
    );
  });

  it("unwraps playback stream events", async () => {
    const callback = vi.fn();
    const streamEvent = {
      streamId: "stream-1",
      state: "started",
      error: null,
    };
    mocks.listen.mockImplementation(async (_event, handler) => {
      handler({ payload: streamEvent });
      return vi.fn();
    });

    await listenToPocketVoiceStream(callback);
    expect(callback).toHaveBeenCalledWith(streamEvent);
  });
});
