import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseOpenAiRealtimeDictation = vi.fn();

vi.mock("../useOpenAiRealtimeDictation", () => ({
  useOpenAiRealtimeDictation: (options: unknown) =>
    mockUseOpenAiRealtimeDictation(options),
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
    expect(onSend).toHaveBeenCalledWith("hello world", undefined, undefined);
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
