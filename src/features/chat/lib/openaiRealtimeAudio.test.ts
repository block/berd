import { describe, expect, it, vi } from "vitest";
import {
  connectOpenAiRealtimePeerConnection,
  flushAudioBuffer,
  mergeRealtimeTranscriptSegment,
  OPENAI_REALTIME_WEBRTC_URL,
} from "./openaiRealtimeAudio";

const delta = (text: string) => ({
  type: "conversation.item.input_audio_transcription.delta" as const,
  delta: text,
});

const completed = (text: string) => ({
  type: "conversation.item.input_audio_transcription.completed" as const,
  transcript: text,
});

describe("mergeRealtimeTranscriptSegment", () => {
  it("concatenates deltas preserving API whitespace", () => {
    let text = "";
    text = mergeRealtimeTranscriptSegment(text, "hello", delta("hello"));
    text = mergeRealtimeTranscriptSegment(text, " world", delta(" world"));
    expect(text).toBe("hello world");
  });

  it("skips completed events that duplicate streamed deltas", () => {
    const text = mergeRealtimeTranscriptSegment(
      "hello world",
      "hello world",
      completed("hello world"),
    );
    expect(text).toBe("hello world");
  });

  it("preserves hyphenated words split across deltas", () => {
    let text = "";
    text = mergeRealtimeTranscriptSegment(text, "three", delta("three"));
    text = mergeRealtimeTranscriptSegment(text, "-", delta("-"));
    text = mergeRealtimeTranscriptSegment(text, "pointers", delta("pointers"));
    expect(text).toBe("three-pointers");
  });

  it("preserves mid-word continuation tokens without spaces", () => {
    let text = "";
    text = mergeRealtimeTranscriptSegment(text, "Madd", delta("Madd"));
    text = mergeRealtimeTranscriptSegment(text, "ie", delta("ie"));
    expect(text).toBe("Maddie");
  });

  it("returns currentText when segmentText is empty", () => {
    expect(mergeRealtimeTranscriptSegment("hello", "", delta(""))).toBe(
      "hello",
    );
  });

  it("returns segmentText when currentText is empty", () => {
    expect(mergeRealtimeTranscriptSegment("", "hello", delta("hello"))).toBe(
      "hello",
    );
  });
});

describe("flushAudioBuffer", () => {
  it("sends one input_audio_buffer.append message per chunk", () => {
    const send = vi.fn();
    const dataChannel = { send } as unknown as RTCDataChannel;
    const chunks = [new Int16Array([1, 2, 3]), new Int16Array([4, 5, 6])];

    flushAudioBuffer(dataChannel, chunks);

    expect(send).toHaveBeenCalledTimes(2);
    for (const call of send.mock.calls) {
      const parsed = JSON.parse(call[0] as string);
      expect(parsed.type).toBe("input_audio_buffer.append");
      expect(typeof parsed.audio).toBe("string");
      expect(parsed.audio.length).toBeGreaterThan(0);
    }
  });

  it("clears the chunks array after flush", () => {
    const send = vi.fn();
    const dataChannel = { send } as unknown as RTCDataChannel;
    const chunks = [new Int16Array([1, 2])];

    flushAudioBuffer(dataChannel, chunks);

    expect(chunks).toHaveLength(0);
  });

  it("is a no-op for an empty chunk array", () => {
    const send = vi.fn();
    const dataChannel = { send } as unknown as RTCDataChannel;

    flushAudioBuffer(dataChannel, []);

    expect(send).not.toHaveBeenCalled();
  });

  it("produces valid base64 that roundtrips to the original PCM bytes", () => {
    const send = vi.fn();
    const dataChannel = { send } as unknown as RTCDataChannel;
    const original = new Int16Array([0, 32767, -32768, 256]);

    flushAudioBuffer(dataChannel, [original]);

    const parsed = JSON.parse(send.mock.calls[0][0] as string);
    const binary = atob(parsed.audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const roundtripped = new Int16Array(bytes.buffer);
    expect(roundtripped).toEqual(original);
  });
});

describe("connectOpenAiRealtimePeerConnection", () => {
  it("exchanges SDP with the OpenAI endpoint", async () => {
    const sdpAnswer = "v=0\r\no=- answer\r\n";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(sdpAnswer, { status: 200 }));

    const setLocalDescription = vi.fn();
    const setRemoteDescription = vi.fn();
    const peerConnection = {
      createOffer: vi.fn().mockResolvedValue({ sdp: "v=0\r\no=- offer\r\n" }),
      setLocalDescription,
      setRemoteDescription,
    } as unknown as RTCPeerConnection;

    await connectOpenAiRealtimePeerConnection({
      peerConnection,
      clientSecret: "test-secret",
    });

    expect(peerConnection.createOffer).toHaveBeenCalled();
    expect(setLocalDescription).toHaveBeenCalledWith({
      sdp: "v=0\r\no=- offer\r\n",
    });
    expect(fetchSpy).toHaveBeenCalledWith(OPENAI_REALTIME_WEBRTC_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-secret",
        "Content-Type": "application/sdp",
      },
      body: "v=0\r\no=- offer\r\n",
    });
    expect(setRemoteDescription).toHaveBeenCalledWith({
      type: "answer",
      sdp: sdpAnswer,
    });

    fetchSpy.mockRestore();
  });

  it("throws on non-200 response with status and body", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("forbidden", { status: 403 }));

    const peerConnection = {
      createOffer: vi.fn().mockResolvedValue({ sdp: "offer" }),
      setLocalDescription: vi.fn(),
      setRemoteDescription: vi.fn(),
    } as unknown as RTCPeerConnection;

    await expect(
      connectOpenAiRealtimePeerConnection({
        peerConnection,
        clientSecret: "bad-secret",
      }),
    ).rejects.toThrow("OpenAI realtime connection failed (403): forbidden");

    fetchSpy.mockRestore();
  });
});
