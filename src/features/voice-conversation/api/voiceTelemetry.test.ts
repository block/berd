import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
import { getVoiceTtsSettings } from "./voiceTelemetry";

beforeEach(() => {
  mocks.invoke.mockReset();
});

it.each([
  [
    "pocket",
    "get_pocket_voice_status",
    { selectedVoice: "vera", voices: [{ id: "vera", name: "Vera" }] },
  ],
  [
    "siri",
    "get_siri_voice_status",
    {
      selectedVoice: { name: "Samantha", language: "en-US" },
      voices: [{ name: "Samantha" }],
    },
  ],
  [
    "openai",
    "get_openai_voice_status",
    { speechVoice: "alloy", speechVoices: ["alloy"] },
  ],
] as const)("reads the effective %s rate and voice", async (backend, command, status) => {
  mocks.invoke.mockResolvedValue({ playbackSpeed: 1.25, ...status });
  expect(await getVoiceTtsSettings(backend)).toEqual({
    rate: 1.25,
    voice: backend === "pocket" ? "vera" : backend === "siri" ? "Samantha" : "alloy",
  });
  expect(mocks.invoke.mock.calls[0][0]).toBe(command);
});

it("reports a voice outside the backend catalog as custom", async () => {
  mocks.invoke.mockResolvedValue({
    playbackSpeed: 1,
    speechVoice: "my-gateway-voice",
    speechVoices: ["alloy"],
  });
  expect(await getVoiceTtsSettings("openai")).toEqual({ rate: 1, voice: "custom" });
});

it("omits the voice when none is selected", async () => {
  mocks.invoke.mockResolvedValue({ playbackSpeed: 1, selectedVoice: null, voices: [] });
  expect(await getVoiceTtsSettings("siri")).toEqual({ rate: 1, voice: null });
});

it("leaves unavailable settings unknown", async () => {
  mocks.invoke.mockRejectedValue(new Error("backend unavailable"));
  expect(await getVoiceTtsSettings("siri")).toEqual({ rate: null, voice: null });
});
