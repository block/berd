import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseOpenAiRealtimeDictation = vi.fn();
const mockUseProfileCapability = vi.fn();

vi.mock("../useOpenAiRealtimeDictation", () => ({
  useOpenAiRealtimeDictation: (options: unknown) =>
    mockUseOpenAiRealtimeDictation(options),
}));

vi.mock("@/shared/profile/capabilities", () => ({
  useProfileCapability: (id: string) => mockUseProfileCapability(id),
}));

import { useVoiceDictation } from "../useVoiceDictation";

describe("useVoiceDictation", () => {
  beforeEach(() => {
    mockUseOpenAiRealtimeDictation.mockReset();
    mockUseOpenAiRealtimeDictation.mockReturnValue({
      isEnabled: true,
      isRecording: false,
      isStarting: () => false,
      isTranscribing: false,
      startRecording: vi.fn(),
      stopRecording: vi.fn(),
      toggleRecording: vi.fn(),
    });
    mockUseProfileCapability.mockReset();
    mockUseProfileCapability.mockReturnValue(true);
  });

  it("disables dictation when the voiceDictation capability is off", () => {
    mockUseProfileCapability.mockReturnValue(false);

    const { result } = renderHook(() =>
      useVoiceDictation({
        attachments: [],
        clearAttachments: vi.fn(),
        onSend: vi.fn(),
        resetTextarea: vi.fn(),
        selectedPersonaId: null,
        setText: vi.fn(),
        text: "",
      }),
    );

    expect(mockUseProfileCapability).toHaveBeenCalledWith("voiceDictation");
    // Forces the underlying dictation hook into its disabled state...
    const options = mockUseOpenAiRealtimeDictation.mock.calls.at(-1)?.[0] as {
      disabled: boolean;
    };
    expect(options.disabled).toBe(true);
    // ...and propagates isEnabled=false even though the inner hook reports true.
    expect(result.current.isEnabled).toBe(false);
  });

  it("keeps dictation enabled when the voiceDictation capability is on", () => {
    const { result } = renderHook(() =>
      useVoiceDictation({
        attachments: [],
        clearAttachments: vi.fn(),
        onSend: vi.fn(),
        resetTextarea: vi.fn(),
        selectedPersonaId: null,
        setText: vi.fn(),
        text: "",
      }),
    );

    const options = mockUseOpenAiRealtimeDictation.mock.calls.at(-1)?.[0] as {
      disabled: boolean;
    };
    expect(options.disabled).toBe(false);
    expect(result.current.isEnabled).toBe(true);
  });

  it("types realtime transcript snapshots into the composer", () => {
    const setText = vi.fn();
    const { rerender } = renderHook(
      ({ text }) =>
        useVoiceDictation({
          attachments: [],
          clearAttachments: vi.fn(),
          onSend: vi.fn(),
          resetTextarea: vi.fn(),
          selectedPersonaId: null,
          setText,
          text,
        }),
      { initialProps: { text: "" } },
    );

    const options = mockUseOpenAiRealtimeDictation.mock.calls.at(-1)?.[0] as {
      onTranscriptText: (text: string) => void;
    };

    options.onTranscriptText("hello");
    expect(setText).toHaveBeenLastCalledWith("hello");

    rerender({ text: "hello" });
    options.onTranscriptText("hello world");
    expect(setText).toHaveBeenLastCalledWith("hello world");
  });

  it("auto-submits when transcript ends with 'submit'", () => {
    const setText = vi.fn();
    const onSend = vi.fn().mockReturnValue(true);
    const clearAttachments = vi.fn();
    const resetTextarea = vi.fn();
    const stopRecording = vi.fn();

    mockUseOpenAiRealtimeDictation.mockImplementation(() => {
      return {
        isEnabled: true,
        isRecording: true,
        isStarting: () => false,
        isTranscribing: true,
        startRecording: vi.fn(),
        stopRecording,
        toggleRecording: vi.fn(),
      };
    });

    const { rerender } = renderHook(
      ({ text }) =>
        useVoiceDictation({
          attachments: [],
          clearAttachments,
          onSend,
          resetTextarea,
          selectedPersonaId: null,
          setText,
          text,
        }),
      { initialProps: { text: "" } },
    );

    const opts = mockUseOpenAiRealtimeDictation.mock.calls.at(-1)?.[0] as {
      onTranscriptText: (text: string) => void;
      onRecordingStart?: () => void;
    };

    // Simulate onRecordingStart to reset internal transcript state
    opts.onRecordingStart?.();

    // First transcript without trigger phrase
    opts.onTranscriptText("hello world");
    expect(setText).toHaveBeenLastCalledWith("hello world");

    rerender({ text: "hello world" });

    // Transcript now ends with "submit"
    opts.onTranscriptText("hello world submit");
    expect(stopRecording).toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith("hello world", null, undefined);
  });

  it("strips trigger phrase but does not send when isSendLocked", () => {
    const setText = vi.fn();
    const onSend = vi.fn();
    const stopRecording = vi.fn();

    mockUseOpenAiRealtimeDictation.mockImplementation(() => ({
      isEnabled: true,
      isRecording: true,
      isStarting: () => false,
      isTranscribing: true,
      startRecording: vi.fn(),
      stopRecording,
      toggleRecording: vi.fn(),
    }));

    renderHook(() =>
      useVoiceDictation({
        attachments: [],
        clearAttachments: vi.fn(),
        onSend,
        resetTextarea: vi.fn(),
        selectedPersonaId: null,
        setText,
        text: "",
        isSendLocked: true,
      }),
    );

    const opts = mockUseOpenAiRealtimeDictation.mock.calls.at(-1)?.[0] as {
      onTranscriptText: (text: string) => void;
      onRecordingStart?: () => void;
    };
    opts.onRecordingStart?.();
    opts.onTranscriptText("hello submit");

    expect(stopRecording).toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(setText).toHaveBeenLastCalledWith("hello");
  });

  it("preserves pre-existing typed text when transcript updates", () => {
    const setText = vi.fn();

    renderHook(() =>
      useVoiceDictation({
        attachments: [],
        clearAttachments: vi.fn(),
        onSend: vi.fn(),
        resetTextarea: vi.fn(),
        selectedPersonaId: null,
        setText,
        text: "typed prefix ",
      }),
    );

    const opts = mockUseOpenAiRealtimeDictation.mock.calls.at(-1)?.[0] as {
      onTranscriptText: (text: string) => void;
      onRecordingStart?: () => void;
    };
    opts.onRecordingStart?.();
    opts.onTranscriptText("dictated words");

    expect(setText).toHaveBeenLastCalledWith("typed prefix dictated words");
  });
});
