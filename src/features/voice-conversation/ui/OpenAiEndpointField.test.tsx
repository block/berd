import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { OpenAiEndpointField } from "./OpenAiEndpointField";

const voiceApi = vi.hoisted(() => ({
  getEndpoints: vi.fn(async () => ({ realtime: null, stt: null, tts: null })),
  getStatus: vi.fn(async () => ({ sttConfigured: true })),
}));

vi.mock("../api/openAiVoice", () => ({
  getOpenAiVoiceEndpoints: voiceApi.getEndpoints,
  getOpenAiVoiceStatus: voiceApi.getStatus,
  setOpenAiVoiceEndpoint: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  voiceApi.getEndpoints.mockResolvedValue({
    realtime: null,
    stt: null,
    tts: null,
  });
});

it("updates a locally saved key indicator when another default service clears the shared key", async () => {
  const user = userEvent.setup();
  const onSaveKey = vi.fn(async () => {});
  const props = {
    kind: "stt" as const,
    label: "STT URL",
    keyLabel: "STT key",
    onSaveKey,
    onClearKey: vi.fn(async () => {}),
  };
  const view = renderWithProviders(
    <OpenAiEndpointField {...props} configured />,
  );
  await screen.findByText("Key saved for this URL in macOS Keychain.");
  await user.type(screen.getByLabelText("STT key"), "new-key");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(onSaveKey).toHaveBeenCalledWith("new-key", "");

  view.rerender(<OpenAiEndpointField {...props} configured={false} />);
  expect(await screen.findByText(/No key set/)).toBeInTheDocument();
});

it("binds key save and removal to the displayed endpoint", async () => {
  voiceApi.getEndpoints.mockResolvedValue({
    realtime: null,
    stt: "wss://first.test/realtime",
    tts: null,
  } as never);
  const user = userEvent.setup();
  const onSaveKey = vi.fn(async () => {});
  const onClearKey = vi.fn(async () => {});
  renderWithProviders(
    <OpenAiEndpointField
      kind="stt"
      label="STT URL"
      keyLabel="STT key"
      configured
      onSaveKey={onSaveKey}
      onClearKey={onClearKey}
    />,
  );
  await screen.findByDisplayValue("wss://first.test/realtime");
  voiceApi.getEndpoints.mockResolvedValue({
    realtime: null,
    stt: "wss://second.test/realtime",
    tts: null,
  } as never);
  await user.type(screen.getByLabelText("STT key"), "first-key");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(onSaveKey).toHaveBeenCalledWith(
    "first-key",
    "wss://first.test/realtime",
  );
  await user.click(screen.getByRole("button", { name: "Remove" }));
  expect(onClearKey).toHaveBeenCalledWith("wss://first.test/realtime");
});
