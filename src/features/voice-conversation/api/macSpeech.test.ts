import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMacSpeechStatus,
  installMacSpeechModel,
  listenToMacSpeechStatus,
  type MacSpeechStatus,
} from "./macSpeech";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

const status: MacSpeechStatus = {
  supported: true,
  unavailableReason: null,
  locale: "en-US",
  localeSupported: true,
  modelInstalled: true,
  installing: false,
  progress: null,
  error: null,
  revision: 2,
};

describe("macOS speech API", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
  });

  it("uses the native status and installation commands", async () => {
    mocks.invoke.mockResolvedValue(status);

    await expect(getMacSpeechStatus()).resolves.toEqual(status);
    await expect(installMacSpeechModel()).resolves.toEqual(status);

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "get_mac_speech_status");
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "install_mac_speech_model");
  });

  it("delivers the status event payload directly", async () => {
    const callback = vi.fn();
    mocks.listen.mockImplementation((_name, listener) => {
      listener({ payload: status });
      return Promise.resolve(vi.fn());
    });

    await listenToMacSpeechStatus(callback);

    expect(callback).toHaveBeenCalledWith(status);
  });
});
