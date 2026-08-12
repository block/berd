import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenAiRealtimeTranscriptEvent } from "../../lib/openaiRealtimeAudio";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetOpenAiRealtimeStatus = vi.fn();
const mockCreateOpenAiRealtimeSession = vi.fn();
const mockClaimVoiceDictationMicrophone = vi.fn();
const mockReleaseVoiceDictationMicrophone = vi.fn();

vi.mock("@/shared/api/openaiRealtime", () => ({
  getOpenAiRealtimeStatus: (...args: unknown[]) =>
    mockGetOpenAiRealtimeStatus(...args),
  createOpenAiRealtimeSession: (...args: unknown[]) =>
    mockCreateOpenAiRealtimeSession(...args),
  claimVoiceDictationMicrophone: (...args: unknown[]) =>
    mockClaimVoiceDictationMicrophone(...args),
  releaseVoiceDictationMicrophone: (...args: unknown[]) =>
    mockReleaseVoiceDictationMicrophone(...args),
}));

const mockConnectOpenAiRealtimePeerConnection = vi.fn();
const mockCreateAudioBufferCapture = vi.fn();
const mockFlushAudioBuffer = vi.fn();

vi.mock("../../lib/openaiRealtimeAudio", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/openaiRealtimeAudio")>();
  return {
    ...actual,
    connectOpenAiRealtimePeerConnection: (...args: unknown[]) =>
      mockConnectOpenAiRealtimePeerConnection(...args),
    createAudioBufferCapture: (...args: unknown[]) =>
      mockCreateAudioBufferCapture(...args),
    createOpenAiRealtimePeerConnection: () => mockPeerConnection,
    flushAudioBuffer: (...args: unknown[]) => mockFlushAudioBuffer(...args),
  };
});

// Suppress console noise in tests
vi.spyOn(console, "debug").mockImplementation(() => {});
vi.spyOn(console, "info").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

// Mock sonner toast
const mockToastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args) },
}));

// Mock browser APIs
let mockPeerConnection: {
  createDataChannel: ReturnType<typeof vi.fn>;
  addTrack: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};
let mockDataChannelListeners: Record<string, ((...args: unknown[]) => void)[]>;
let mockDataChannel: {
  addEventListener: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
};
let mockStream: {
  getAudioTracks: ReturnType<typeof vi.fn>;
  getTracks: ReturnType<typeof vi.fn>;
};
let mockTrack: { stop: ReturnType<typeof vi.fn> };
let mockAudioCapture: { chunks: Int16Array[]; close: ReturnType<typeof vi.fn> };

import { useOpenAiRealtimeDictation } from "../useOpenAiRealtimeDictation";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function setupMocks() {
  mockDataChannelListeners = {};
  mockDataChannel = {
    addEventListener: vi.fn((event: string, handler: () => void) => {
      if (!mockDataChannelListeners[event]) {
        mockDataChannelListeners[event] = [];
      }
      mockDataChannelListeners[event].push(handler);
    }),
    close: vi.fn(),
    send: vi.fn(),
  };
  mockPeerConnection = {
    createDataChannel: vi.fn().mockReturnValue(mockDataChannel),
    addTrack: vi.fn(),
    close: vi.fn(),
  };
  mockTrack = { stop: vi.fn() };
  mockStream = {
    getAudioTracks: vi.fn().mockReturnValue([mockTrack]),
    getTracks: vi.fn().mockReturnValue([mockTrack]),
  };
  mockAudioCapture = { chunks: [], close: vi.fn() };

  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: vi.fn().mockResolvedValue(mockStream) },
    writable: true,
    configurable: true,
  });

  mockGetOpenAiRealtimeStatus.mockResolvedValue({ configured: true });
  mockClaimVoiceDictationMicrophone.mockResolvedValue(undefined);
  mockReleaseVoiceDictationMicrophone.mockResolvedValue(undefined);
  mockCreateOpenAiRealtimeSession.mockResolvedValue({
    clientSecret: "secret",
    transcriptionModel: "whisper-1",
  });
  mockCreateAudioBufferCapture.mockResolvedValue(mockAudioCapture);
  mockConnectOpenAiRealtimePeerConnection.mockResolvedValue(undefined);
}

// ---------------------------------------------------------------------------
// Helper to render the hook in the "configured + enabled" state
// ---------------------------------------------------------------------------

async function renderDictationHook(
  overrides?: Partial<Parameters<typeof useOpenAiRealtimeDictation>[0]>,
) {
  setupMocks();

  const onTranscriptText = vi.fn();
  const onRecordingStart = vi.fn();

  const hookResult = renderHook(() =>
    useOpenAiRealtimeDictation({
      onTranscriptText,
      onRecordingStart,
      ...overrides,
    }),
  );

  // Let the useEffect that checks status resolve
  await act(async () => {});

  return { ...hookResult, onTranscriptText, onRecordingStart };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useOpenAiRealtimeDictation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("configuration availability", () => {
    it("rechecks status when availability changes without remounting", async () => {
      setupMocks();
      mockGetOpenAiRealtimeStatus
        .mockResolvedValueOnce({ configured: true })
        .mockResolvedValueOnce({ configured: false });

      const { result, rerender } = renderHook(
        ({ disabled }) =>
          useOpenAiRealtimeDictation({
            disabled,
            onTranscriptText: vi.fn(),
          }),
        { initialProps: { disabled: true } },
      );

      expect(result.current.isEnabled).toBe(false);
      expect(mockGetOpenAiRealtimeStatus).not.toHaveBeenCalled();

      await act(async () => rerender({ disabled: false }));
      expect(result.current.isEnabled).toBe(true);

      await act(async () => rerender({ disabled: true }));
      expect(result.current.isEnabled).toBe(false);

      await act(async () => rerender({ disabled: false }));
      expect(result.current.isEnabled).toBe(false);
      expect(mockGetOpenAiRealtimeStatus).toHaveBeenCalledTimes(2);
    });

    it("stops active dictation when availability is disabled", async () => {
      setupMocks();
      const onTranscriptText = vi.fn();
      const { result, rerender } = renderHook(
        ({ disabled }) =>
          useOpenAiRealtimeDictation({ disabled, onTranscriptText }),
        { initialProps: { disabled: false } },
      );
      await act(async () => {});
      await act(async () => result.current.startRecording());
      expect(result.current.isRecording).toBe(true);

      await act(async () => rerender({ disabled: true }));

      expect(result.current.isEnabled).toBe(false);
      expect(result.current.isRecording).toBe(false);
      expect(result.current.isStarting()).toBe(false);
      expect(result.current.isTranscribing).toBe(false);
      expect(mockAudioCapture.close).toHaveBeenCalledOnce();
      expect(mockDataChannel.close).toHaveBeenCalledOnce();
      expect(mockPeerConnection.close).toHaveBeenCalledOnce();
      expect(mockTrack.stop).toHaveBeenCalledOnce();
      expect(mockReleaseVoiceDictationMicrophone).toHaveBeenCalledOnce();
    });

    it("ignores stale status results after newer availability changes", async () => {
      setupMocks();
      const staleConfigured = createDeferred<{ configured: boolean }>();
      mockGetOpenAiRealtimeStatus
        .mockReturnValueOnce(staleConfigured.promise)
        .mockResolvedValueOnce({ configured: false });

      const { result, rerender } = renderHook(
        ({ disabled }) =>
          useOpenAiRealtimeDictation({
            disabled,
            onTranscriptText: vi.fn(),
          }),
        { initialProps: { disabled: false } },
      );

      await act(async () => rerender({ disabled: true }));
      await act(async () => rerender({ disabled: false }));
      expect(result.current.isEnabled).toBe(false);

      await act(async () => staleConfigured.resolve({ configured: true }));
      expect(result.current.isEnabled).toBe(false);

      const staleFailure = createDeferred<{ configured: boolean }>();
      mockGetOpenAiRealtimeStatus
        .mockReturnValueOnce(staleFailure.promise)
        .mockResolvedValueOnce({ configured: true });

      await act(async () => rerender({ disabled: true }));
      await act(async () => rerender({ disabled: false }));
      await act(async () => rerender({ disabled: true }));
      await act(async () => rerender({ disabled: false }));
      expect(result.current.isEnabled).toBe(true);

      await act(async () => staleFailure.reject(new Error("stale failure")));
      expect(result.current.isEnabled).toBe(true);
    });
  });

  describe("handleRealtimeEvent", () => {
    it("updates transcript on delta events", async () => {
      const { result, onTranscriptText } = await renderDictationHook();

      await act(async () => {
        await result.current.startRecording();
      });

      // Simulate data channel message
      const messageHandler = mockDataChannelListeners.message?.[0];
      expect(messageHandler).toBeDefined();

      act(() => {
        messageHandler?.({
          data: JSON.stringify({
            type: "conversation.item.input_audio_transcription.delta",
            delta: "hello",
          } satisfies OpenAiRealtimeTranscriptEvent),
        });
      });

      expect(onTranscriptText).toHaveBeenCalledWith("hello");

      act(() => {
        messageHandler?.({
          data: JSON.stringify({
            type: "conversation.item.input_audio_transcription.delta",
            delta: " world",
          } satisfies OpenAiRealtimeTranscriptEvent),
        });
      });

      expect(onTranscriptText).toHaveBeenLastCalledWith("hello world");
    });

    it("sets isTranscribing to false on completed events", async () => {
      const { result } = await renderDictationHook();

      await act(async () => {
        await result.current.startRecording();
      });

      const messageHandler = mockDataChannelListeners.message?.[0];

      // Send a completed event as the first event (no prior deltas) so
      // the merge produces new text and isTranscribing is set.
      act(() => {
        messageHandler?.({
          data: JSON.stringify({
            type: "conversation.item.input_audio_transcription.completed",
            transcript: "hello",
          }),
        });
      });

      expect(result.current.isTranscribing).toBe(false);
    });

    it("toasts on error events", async () => {
      const { result } = await renderDictationHook();

      await act(async () => {
        await result.current.startRecording();
      });

      const messageHandler = mockDataChannelListeners.message?.[0];

      act(() => {
        messageHandler?.({
          data: JSON.stringify({
            type: "error",
            error: { message: "something went wrong" },
          }),
        });
      });

      expect(mockToastError).toHaveBeenCalledWith("something went wrong");
    });

    it("ignores non-transcript events without state changes", async () => {
      const { result, onTranscriptText } = await renderDictationHook();

      await act(async () => {
        await result.current.startRecording();
      });

      const messageHandler = mockDataChannelListeners.message?.[0];

      act(() => {
        messageHandler?.({
          data: JSON.stringify({
            type: "session.created",
          }),
        });
      });

      expect(onTranscriptText).not.toHaveBeenCalled();
    });
  });

  describe("startRecording lifecycle", () => {
    it("sets isRecording after mic is acquired", async () => {
      const { result, onRecordingStart } = await renderDictationHook();

      expect(result.current.isRecording).toBe(false);

      await act(async () => {
        await result.current.startRecording();
      });

      expect(result.current.isRecording).toBe(true);
      expect(onRecordingStart).toHaveBeenCalled();
      expect(mockClaimVoiceDictationMicrophone).toHaveBeenCalledOnce();
    });

    it("clears isStarting after connection completes", async () => {
      const { result } = await renderDictationHook();

      await act(async () => {
        await result.current.startRecording();
      });

      expect(result.current.isStarting()).toBe(false);
    });
  });

  describe("startRecording error handling", () => {
    it("resets state and toasts on getUserMedia failure", async () => {
      const { result } = await renderDictationHook();

      // Override after hook is rendered so setupMocks() doesn't clobber it
      (
        navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new Error("mic denied"));

      await act(async () => {
        await result.current.startRecording();
      });

      expect(result.current.isRecording).toBe(false);
      expect(mockReleaseVoiceDictationMicrophone).toHaveBeenCalledOnce();
      expect(mockToastError).toHaveBeenCalledWith(
        "Microphone access is blocked",
        {
          description:
            "Allow microphone access for Berd in System Settings, then try voice dictation again.",
        },
      );
    });

    it("cleans up and toasts on session creation failure", async () => {
      const { result } = await renderDictationHook();

      mockCreateOpenAiRealtimeSession.mockRejectedValue(
        new Error("session failed"),
      );

      await act(async () => {
        await result.current.startRecording();
      });

      expect(result.current.isRecording).toBe(false);
      expect(mockToastError).toHaveBeenCalledWith("Voice dictation failed", {
        description: "session failed",
      });
      expect(mockTrack.stop).toHaveBeenCalled();
    });

    it("cleans up all resources on WebRTC connection failure", async () => {
      const { result } = await renderDictationHook();

      mockConnectOpenAiRealtimePeerConnection.mockRejectedValue(
        new Error("webrtc failed"),
      );

      await act(async () => {
        await result.current.startRecording();
      });

      expect(result.current.isRecording).toBe(false);
      expect(mockToastError).toHaveBeenCalledWith("Voice dictation failed", {
        description: "webrtc failed",
      });
      expect(mockPeerConnection.close).toHaveBeenCalled();
      expect(mockAudioCapture.close).toHaveBeenCalled();
    });
  });

  describe("stopRecording / cleanup", () => {
    it("closes all resources and resets state", async () => {
      const { result } = await renderDictationHook();

      await act(async () => {
        await result.current.startRecording();
      });

      expect(result.current.isRecording).toBe(true);

      act(() => {
        result.current.stopRecording();
      });

      expect(result.current.isRecording).toBe(false);
      expect(result.current.isTranscribing).toBe(false);
      expect(mockPeerConnection.close).toHaveBeenCalled();
      expect(mockDataChannel.close).toHaveBeenCalled();
      expect(mockReleaseVoiceDictationMicrophone).toHaveBeenCalledOnce();
    });

    it("does not request the OS microphone when another window owns it", async () => {
      const { result } = await renderDictationHook();
      mockClaimVoiceDictationMicrophone.mockRejectedValue(
        new Error("A voice conversation is already using the microphone"),
      );

      await act(async () => {
        await result.current.startRecording();
      });

      expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
      expect(result.current.isRecording).toBe(false);
    });

    it("retries a failed microphone release before clearing ownership", async () => {
      const { result } = await renderDictationHook();
      await act(async () => {
        await result.current.startRecording();
      });
      mockReleaseVoiceDictationMicrophone
        .mockRejectedValueOnce(new Error("invoke dropped"))
        .mockResolvedValue(undefined);

      act(() => {
        result.current.stopRecording();
      });
      await act(
        () =>
          new Promise((resolve) => {
            setTimeout(resolve, 75);
          }),
      );

      expect(mockReleaseVoiceDictationMicrophone).toHaveBeenCalledTimes(2);
    });
  });
});
