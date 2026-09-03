import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { getSiriVoiceStatus, startSiriVoiceStream } from "./siriVoice";

describe("Siri voice API", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
  });

  it("passes the selected language to voice discovery", async () => {
    const status = { supported: true, voices: [] };
    mocks.invoke.mockResolvedValue(status);

    await expect(getSiriVoiceStatus("fr-CA")).resolves.toBe(status);

    expect(mocks.invoke).toHaveBeenCalledWith("get_siri_voice_status", {
      languagePrefix: "fr-CA",
    });
  });

  it("coalesces only matching regional locale requests", async () => {
    let resolveRequest: ((value: unknown) => void) | undefined;
    mocks.invoke.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );

    const first = getSiriVoiceStatus("en-US", { coalesce: true });
    const joined = getSiriVoiceStatus("en_US", { coalesce: true });
    const separate = getSiriVoiceStatus("en-AU", { coalesce: true });

    expect(first).toBe(joined);
    expect(separate).not.toBe(first);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    resolveRequest?.({ supported: true, voices: [] });
    await Promise.all([first, joined, separate]);
  });

  it("passes the resolved voice to stream playback", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    const voice = { name: "Samantha", language: "en-US" };

    await startSiriVoiceStream(
      "session-1",
      4,
      7,
      "stream-1",
      voice,
      "allowInterruptions",
      "balanced",
    );

    expect(mocks.invoke).toHaveBeenCalledWith("start_siri_voice_stream", {
      sessionId: "session-1",
      expectedRevision: 4,
      speechId: 7,
      streamId: "stream-1",
      voice,
      interruptionMode: "allowInterruptions",
      interruptionSensitivity: "balanced",
    });
  });
});
