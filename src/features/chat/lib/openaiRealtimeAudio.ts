import {
  REALTIME_BUFFER_PROCESSOR_NAME,
  createWorkletBlobUrl,
} from "./realtimeBufferWorklet";

export const OPENAI_REALTIME_WEBRTC_URL =
  "https://api.openai.com/v1/realtime/calls";
export const OPENAI_REALTIME_TRANSCRIPT_DELTA_EVENT =
  "conversation.item.input_audio_transcription.delta";
export const OPENAI_REALTIME_TRANSCRIPT_COMPLETED_EVENT =
  "conversation.item.input_audio_transcription.completed";

const MAX_BUFFER_CHUNKS = 500; // ~10 seconds at 20ms per chunk

export type OpenAiRealtimeTranscriptEvent = {
  type?: string;
  item_id?: string;
  content_index?: number;
  delta?: string;
  transcript?: string;
  message?: string;
  error?: {
    message?: string;
  };
};

export function createOpenAiRealtimePeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection();
}

export async function connectOpenAiRealtimePeerConnection(options: {
  peerConnection: RTCPeerConnection;
  clientSecret: string;
}): Promise<void> {
  const offer = await options.peerConnection.createOffer();
  await options.peerConnection.setLocalDescription(offer);

  const response = await fetch(OPENAI_REALTIME_WEBRTC_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.clientSecret}`,
      "Content-Type": "application/sdp",
    },
    body: offer.sdp ?? "",
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `OpenAI realtime connection failed (${response.status}): ${body}`,
    );
  }

  await options.peerConnection.setRemoteDescription({
    type: "answer",
    sdp: body,
  });
}

export function mergeRealtimeTranscriptSegment(
  currentText: string,
  segmentText: string,
  event: OpenAiRealtimeTranscriptEvent,
): string {
  if (!segmentText) return currentText;
  if (!currentText) return segmentText;

  // Completed events re-send the full segment text; skip if already present.
  if (event.type === OPENAI_REALTIME_TRANSCRIPT_COMPLETED_EVENT) {
    const normalizedCurrent = currentText.trimEnd().toLowerCase();
    const normalizedText = segmentText.trim().toLowerCase();
    if (normalizedCurrent.endsWith(normalizedText)) {
      return currentText;
    }
  }

  return currentText + segmentText;
}

// ---------------------------------------------------------------------------
// Audio buffer capture — mic → AudioWorklet → PCM chunk queue
// ---------------------------------------------------------------------------

export interface AudioBufferCapture {
  /** Accumulated 24kHz Int16 PCM chunks (20ms each). */
  chunks: Int16Array[];
  /** Tear down the AudioContext and worklet graph. */
  close(): void;
}

/**
 * Start capturing PCM audio from `stream` into a chunk queue via an
 * AudioWorklet. Call `.close()` once the WebRTC data channel is open and
 * the buffer has been flushed.
 */
export async function createAudioBufferCapture(
  stream: MediaStream,
): Promise<AudioBufferCapture> {
  const audioContext = new AudioContext();
  const blobUrl = createWorkletBlobUrl();
  try {
    await audioContext.audioWorklet.addModule(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }

  const source = audioContext.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(
    audioContext,
    REALTIME_BUFFER_PROCESSOR_NAME,
  );
  // Connect through the graph so the worklet's process() is called.
  // The worklet produces silence on its output so nothing is audible.
  source.connect(worklet);
  worklet.connect(audioContext.destination);

  const chunks: Int16Array[] = [];
  worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    if (chunks.length < MAX_BUFFER_CHUNKS) {
      chunks.push(new Int16Array(event.data));
    }
  };

  return {
    chunks,
    close() {
      worklet.disconnect();
      source.disconnect();
      void audioContext.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Flush buffered PCM into the data channel
// ---------------------------------------------------------------------------

function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Send all buffered PCM chunks to OpenAI via `input_audio_buffer.append`
 * events on the data channel, then clear the array.
 */
export function flushAudioBuffer(
  dataChannel: RTCDataChannel,
  chunks: Int16Array[],
): void {
  for (const chunk of chunks) {
    dataChannel.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: int16ToBase64(chunk),
      }),
    );
  }
  chunks.length = 0;
}
