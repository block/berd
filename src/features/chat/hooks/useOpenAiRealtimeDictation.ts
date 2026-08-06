import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  claimVoiceDictationMicrophone,
  createOpenAiRealtimeSession,
  getOpenAiRealtimeStatus,
  releaseVoiceDictationMicrophone,
} from "@/shared/api/openaiRealtime";
import {
  type AudioBufferCapture,
  connectOpenAiRealtimePeerConnection,
  createAudioBufferCapture,
  createOpenAiRealtimePeerConnection,
  flushAudioBuffer,
  mergeRealtimeTranscriptSegment,
  OPENAI_REALTIME_TRANSCRIPT_COMPLETED_EVENT,
  OPENAI_REALTIME_TRANSCRIPT_DELTA_EVENT,
  type OpenAiRealtimeTranscriptEvent,
} from "../lib/openaiRealtimeAudio";

interface UseOpenAiRealtimeDictationOptions {
  disabled?: boolean;
  onRecordingStart?: () => void;
  onTranscriptText: (text: string) => void;
}

interface DictationErrorToast {
  description?: string;
  title: string;
}

const LOGGED_REALTIME_EVENT_TYPES = new Set([
  "session.created",
  "session.updated",
  "error",
  "input_audio_buffer.speech_started",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.committed",
]);
const MICROPHONE_RELEASE_ATTEMPTS = 3;

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "Voice input failed";
  }
}

function getErrorName(error: unknown) {
  return error instanceof Error ? error.name : "";
}

function formatDictationStartErrorToast(
  error: unknown,
  t: ReturnType<typeof useTranslation<"chat">>["t"],
): DictationErrorToast {
  const errorName = getErrorName(error);
  const message = getErrorMessage(error);

  if (
    errorName === "NotAllowedError" ||
    errorName === "PermissionDeniedError" ||
    errorName === "SecurityError" ||
    /not allowed|denied|permission/i.test(message)
  ) {
    return {
      title: t("errors.voiceInputPermissionTitle"),
      description: t("errors.voiceInputPermissionDescription"),
    };
  }

  if (
    errorName === "NotFoundError" ||
    errorName === "DevicesNotFoundError" ||
    /no microphone|no audio input|requested device not found/i.test(message)
  ) {
    return {
      title: t("errors.voiceInputNoMicrophoneTitle"),
      description: t("errors.voiceInputNoMicrophoneDescription"),
    };
  }

  if (
    errorName === "NotReadableError" ||
    errorName === "TrackStartError" ||
    errorName === "AbortError"
  ) {
    return {
      title: t("errors.voiceInputUnavailableTitle"),
      description: t("errors.voiceInputUnavailableDescription"),
    };
  }

  return {
    title: t("errors.voiceInputFailedTitle"),
    description: message || undefined,
  };
}

function closeRealtimeResources(resources: {
  audioCapture?: AudioBufferCapture | null;
  dataChannel?: RTCDataChannel | null;
  peerConnection?: RTCPeerConnection | null;
  stream?: MediaStream | null;
}) {
  resources.audioCapture?.close();
  resources.dataChannel?.close();
  resources.peerConnection?.close();
  resources.stream?.getTracks().forEach((track) => {
    track.stop();
  });
}

export function useOpenAiRealtimeDictation({
  disabled = false,
  onRecordingStart,
  onTranscriptText,
}: UseOpenAiRealtimeDictationOptions) {
  const { t } = useTranslation("chat");
  const [isRecording, setIsRecording] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isConfigured, setIsConfigured] = useState(false);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCaptureRef = useRef<AudioBufferCapture | null>(null);
  const transcriptRef = useRef("");
  const activeRunIdRef = useRef(0);
  const microphoneOwnerRef = useRef<string | null>(null);
  const dictationInstanceId = useId();
  const recordingStartTimeRef = useRef(0);
  const onRecordingStartRef = useRef(onRecordingStart);
  const onTranscriptTextRef = useRef(onTranscriptText);
  onRecordingStartRef.current = onRecordingStart;
  onTranscriptTextRef.current = onTranscriptText;

  const isEnabled = !disabled && isConfigured;

  const releaseMicrophone = useCallback(async (ownerId: string) => {
    for (
      let attempt = 1;
      attempt <= MICROPHONE_RELEASE_ATTEMPTS;
      attempt += 1
    ) {
      try {
        await releaseVoiceDictationMicrophone(ownerId);
        if (microphoneOwnerRef.current === ownerId) {
          microphoneOwnerRef.current = null;
        }
        return true;
      } catch (error) {
        if (attempt === MICROPHONE_RELEASE_ATTEMPTS) {
          console.warn("Failed to release voice dictation microphone", error);
          return false;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, attempt * 50);
        });
      }
    }
    return false;
  }, []);

  const cleanupResources = useCallback(() => {
    activeRunIdRef.current += 1;
    closeRealtimeResources({
      audioCapture: audioCaptureRef.current,
      dataChannel: dataChannelRef.current,
      peerConnection: peerConnectionRef.current,
      stream: streamRef.current,
    });
    audioCaptureRef.current = null;
    dataChannelRef.current = null;
    peerConnectionRef.current = null;
    streamRef.current = null;
    const microphoneOwner = microphoneOwnerRef.current;
    if (microphoneOwner) {
      void releaseMicrophone(microphoneOwner);
    }
  }, [releaseMicrophone]);

  const cleanup = useCallback(() => {
    cleanupResources();
    setIsRecording(false);
    setIsStarting(false);
    setIsTranscribing(false);
  }, [cleanupResources]);

  useEffect(() => cleanupResources, [cleanupResources]);

  useEffect(() => {
    let cancelled = false;
    setIsConfigured(false);

    if (disabled) {
      cleanup();
      return () => {
        cancelled = true;
      };
    }

    // Sibling dictation hooks probe status in the same tick; share one IPC call.
    getOpenAiRealtimeStatus({ coalesce: true })
      .then((status) => {
        if (!cancelled) {
          setIsConfigured(status.configured);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIsConfigured(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cleanup, disabled]);

  const handleRealtimeEvent = useCallback(
    (event: OpenAiRealtimeTranscriptEvent) => {
      if (event.type && LOGGED_REALTIME_EVENT_TYPES.has(event.type)) {
        console.debug("OpenAI realtime event", event);
      }

      if (event.type === "error") {
        console.error("OpenAI realtime server error", event);
        toast.error(
          event.error?.message ??
            event.message ??
            "OpenAI realtime server error",
        );
        return;
      }

      if (
        event.type !== OPENAI_REALTIME_TRANSCRIPT_DELTA_EVENT &&
        event.type !== OPENAI_REALTIME_TRANSCRIPT_COMPLETED_EVENT
      ) {
        return;
      }

      if (
        event.type === OPENAI_REALTIME_TRANSCRIPT_DELTA_EVENT &&
        !transcriptRef.current &&
        recordingStartTimeRef.current
      ) {
        console.debug(
          `[dictation ${(performance.now() - recordingStartTimeRef.current).toFixed(0)}ms] first transcript delta received`,
        );
      }

      const text = event.delta ?? event.transcript ?? "";
      console.info("OpenAI realtime transcript event", {
        type: event.type,
        text,
        itemId: event.item_id,
        contentIndex: event.content_index,
      });
      const merged = mergeRealtimeTranscriptSegment(
        transcriptRef.current,
        text,
        event,
      );

      if (merged === transcriptRef.current) {
        console.info("OpenAI realtime transcript merge skipped (unchanged)");
        return;
      }

      console.info("OpenAI realtime transcript merged", {
        merged,
      });
      transcriptRef.current = merged;
      onTranscriptTextRef.current(merged);
      setIsTranscribing(
        event.type !== OPENAI_REALTIME_TRANSCRIPT_COMPLETED_EVENT,
      );
    },
    [],
  );

  const startRecording = useCallback(async () => {
    if (!isEnabled || isStarting || isRecording) {
      return;
    }

    const runId = activeRunIdRef.current + 1;
    activeRunIdRef.current = runId;
    const isStaleRun = () => activeRunIdRef.current !== runId;
    let stream: MediaStream | null = null;
    let audioCapture: AudioBufferCapture | null = null;
    let peerConnection: RTCPeerConnection | null = null;
    let dataChannel: RTCDataChannel | null = null;
    const microphoneOwner = `${dictationInstanceId}:${runId}`;

    setIsStarting(true);
    transcriptRef.current = "";
    onRecordingStartRef.current?.();

    const t0 = performance.now();
    recordingStartTimeRef.current = t0;
    const elapsed = () => `${(performance.now() - t0).toFixed(0)}ms`;

    try {
      // Coordinate microphone ownership in the backend before asking the OS.
      // The backend is shared by every Tauri window, unlike renderer state.
      const previousMicrophoneOwner = microphoneOwnerRef.current;
      if (
        previousMicrophoneOwner &&
        !(await releaseMicrophone(previousMicrophoneOwner))
      ) {
        throw new Error("Could not release the previous microphone session");
      }
      await claimVoiceDictationMicrophone(microphoneOwner);
      microphoneOwnerRef.current = microphoneOwner;
      if (isStaleRun()) {
        void releaseMicrophone(microphoneOwner);
        return;
      }

      // 1. Capture mic immediately so the user gets instant feedback.
      console.debug(`[dictation ${elapsed()}] requesting mic...`);
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      console.debug(`[dictation ${elapsed()}] mic acquired`);
      if (isStaleRun()) {
        closeRealtimeResources({ stream });
        return;
      }
      streamRef.current = stream;
      setIsRecording(true);

      // 2. Start buffering PCM via AudioWorklet while network calls proceed.
      console.debug(`[dictation ${elapsed()}] creating audio worklet...`);
      audioCapture = await createAudioBufferCapture(stream);
      console.debug(`[dictation ${elapsed()}] audio worklet ready`);
      if (isStaleRun()) {
        closeRealtimeResources({ audioCapture, stream });
        return;
      }
      audioCaptureRef.current = audioCapture;

      // 3. Create session (skip redundant status pre-check — session
      //    creation fails with a clear error if the key is missing).
      console.debug(`[dictation ${elapsed()}] creating session...`);
      const session = await createOpenAiRealtimeSession();
      console.debug(`[dictation ${elapsed()}] session created`);
      if (isStaleRun()) {
        closeRealtimeResources({ audioCapture, stream });
        return;
      }

      // 4. Set up WebRTC peer connection and data channel.
      console.debug(`[dictation ${elapsed()}] setting up WebRTC...`);
      peerConnection = createOpenAiRealtimePeerConnection();
      peerConnectionRef.current = peerConnection;
      const activeStream = stream;
      stream.getAudioTracks().forEach((track) => {
        peerConnection?.addTrack(track, activeStream);
      });

      dataChannel = peerConnection.createDataChannel("oai-events");
      dataChannelRef.current = dataChannel;
      dataChannel.addEventListener("message", (message) => {
        try {
          handleRealtimeEvent(JSON.parse(String(message.data)));
        } catch {
          // Ignore non-JSON or unexpected realtime events.
        }
      });

      // Flush buffered audio once the data channel is ready.
      const channelToFlush = dataChannel;
      const captureToFlush = audioCapture;
      const flushElapsed = elapsed;
      dataChannel.addEventListener("open", () => {
        console.debug(
          `[dictation ${flushElapsed()}] data channel open, flushing ${captureToFlush.chunks.length} buffered chunks`,
        );
        flushAudioBuffer(channelToFlush, captureToFlush.chunks);
        captureToFlush.close();
        audioCaptureRef.current = null;
      });

      console.debug(
        `[dictation ${elapsed()}] connecting peer (SDP exchange)...`,
      );
      await connectOpenAiRealtimePeerConnection({
        peerConnection,
        clientSecret: session.clientSecret,
      });
      console.debug(`[dictation ${elapsed()}] peer connected`);
      if (isStaleRun()) {
        closeRealtimeResources({
          audioCapture,
          dataChannel,
          peerConnection,
          stream,
        });
        return;
      }
    } catch (error) {
      void releaseMicrophone(microphoneOwner);
      closeRealtimeResources({
        audioCapture,
        dataChannel,
        peerConnection,
        stream,
      });
      if (!isStaleRun()) {
        audioCaptureRef.current = null;
        dataChannelRef.current = null;
        peerConnectionRef.current = null;
        streamRef.current = null;
        setIsRecording(false);
        setIsTranscribing(false);
        const toastContent = formatDictationStartErrorToast(error, t);
        console.error("OpenAI realtime voice input failed", error);
        toast.error(toastContent.title, {
          description: toastContent.description,
        });
      }
    } finally {
      if (!isStaleRun()) {
        setIsStarting(false);
      }
    }
  }, [
    dictationInstanceId,
    handleRealtimeEvent,
    isEnabled,
    isRecording,
    isStarting,
    releaseMicrophone,
    t,
  ]);

  const stopRecording = useCallback(() => {
    cleanup();
  }, [cleanup]);

  const toggleRecording = useCallback(() => {
    if (isRecording || isStarting) {
      stopRecording();
      return;
    }
    void startRecording();
  }, [isRecording, isStarting, startRecording, stopRecording]);

  return {
    isEnabled,
    isRecording,
    isStarting: () => isStarting,
    isTranscribing,
    startRecording,
    stopRecording,
    toggleRecording,
  };
}
