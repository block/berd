import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
import { getVoiceTtsRate } from "./voiceTelemetry";

beforeEach(() => {
  mocks.invoke.mockReset();
});

it.each([
  ["pocket", "get_pocket_voice_status"],
  ["siri", "get_siri_voice_status"],
  ["openai", "get_openai_voice_status"],
] as const)("reads the effective %s playback multiplier", async (backend, command) => {
  mocks.invoke.mockResolvedValue({ playbackSpeed: 1.25 });
  expect(await getVoiceTtsRate(backend)).toBe(1.25);
  expect(mocks.invoke.mock.calls[0][0]).toBe(command);
});

it("leaves unavailable rates unknown", async () => {
  mocks.invoke.mockRejectedValue(new Error("backend unavailable"));
  expect(await getVoiceTtsRate("siri")).toBeNull();
});
