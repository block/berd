import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startNativeMicrophone } from "./nativeMicrophone";

const mocks = vi.hoisted(() => ({
  addModule: vi.fn(),
  close: vi.fn(),
  invoke: vi.fn(),
  resume: vi.fn(),
  sourceConnect: vi.fn(),
  sourceDisconnect: vi.fn(),
  stopTrack: vi.fn(),
  workletConnect: vi.fn(),
  workletDisconnect: vi.fn(),
}));

class FakeAudioWorkletNode {
  readonly port: {
    onmessage: ((event: MessageEvent<Float32Array>) => void) | null;
  } = {
    onmessage: null,
  };

  connect = mocks.workletConnect;
  disconnect = mocks.workletDisconnect;
}

class FakeAudioContext {
  state: AudioContextState = "running";
  sampleRate = 48_000;
  destination = {} as AudioDestinationNode;
  audioWorklet = { addModule: mocks.addModule };
  createMediaStreamSource = vi.fn(() => ({
    connect: mocks.sourceConnect,
    disconnect: mocks.sourceDisconnect,
  }));
  close = mocks.close;
  resume = mocks.resume;
}

let fakeTrack: MediaStreamTrack & { enabled: boolean };

describe("native microphone", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => {
      mock.mockReset();
    });
    mocks.addModule.mockResolvedValue(undefined);
    mocks.close.mockResolvedValue(undefined);
    mocks.resume.mockResolvedValue(undefined);
    mocks.invoke.mockResolvedValue(undefined);
    mocks.stopTrack.mockReset();
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    vi.stubGlobal(
      "MediaStream",
      class {
        constructor(readonly tracks: MediaStreamTrack[]) {}
      },
    );
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: { invoke: mocks.invoke },
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockImplementation(() => {
          fakeTrack = {
            enabled: true,
            stop: mocks.stopTrack,
          } as unknown as MediaStreamTrack & { enabled: boolean };
          return Promise.resolve({
            getAudioTracks: () => [fakeTrack],
            getTracks: () => [fakeTrack],
          });
        }),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("ships raw float PCM through Tauri and tears down once", async () => {
    const microphone = await startNativeMicrophone();
    const worklet = mocks.sourceConnect.mock.calls[0]?.[0] as
      | FakeAudioWorkletNode
      | undefined;
    expect(worklet).toBeInstanceOf(FakeAudioWorkletNode);
    expect(mocks.workletConnect).toHaveBeenCalledWith(expect.any(Object));

    const samples = new Float32Array([0.25, -0.5]);
    worklet?.port.onmessage?.({ data: samples } as MessageEvent<Float32Array>);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "push_native_voice_audio",
      new Uint8Array(samples.buffer),
    );

    microphone.stop();
    microphone.stop();
    expect(mocks.stopTrack).toHaveBeenCalledOnce();
    expect(mocks.workletDisconnect).toHaveBeenCalledOnce();
    expect(mocks.sourceDisconnect).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("mutes with silent track frames without tearing down capture", async () => {
    const microphone = await startNativeMicrophone();

    microphone.setMuted(true);
    expect(fakeTrack.enabled).toBe(false);
    expect(mocks.stopTrack).not.toHaveBeenCalled();
    expect(mocks.workletDisconnect).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();

    microphone.setMuted(false);
    expect(fakeTrack.enabled).toBe(true);
  });

  it("reports a transport overrun once without an unhandled rejection", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mocks.invoke.mockRejectedValue(new Error("Native voice audio overrun"));
    const microphone = await startNativeMicrophone();
    const worklet = mocks.sourceConnect.mock.calls[0]?.[0] as
      | FakeAudioWorkletNode
      | undefined;
    const samples = new Float32Array([0.25]);

    worklet?.port.onmessage?.({ data: samples } as MessageEvent<Float32Array>);
    worklet?.port.onmessage?.({ data: samples } as MessageEvent<Float32Array>);
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledOnce());

    microphone.stop();
    consoleError.mockRestore();
  });

  it("fails closed when Web Audio does not honor the required sample rate", async () => {
    class WrongRateAudioContext extends FakeAudioContext {
      override sampleRate = 44_100;
    }
    vi.stubGlobal("AudioContext", WrongRateAudioContext);

    await expect(startNativeMicrophone()).rejects.toThrow(
      "requires 48 kHz microphone audio",
    );
    expect(mocks.stopTrack).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.addModule).not.toHaveBeenCalled();
  });
});
