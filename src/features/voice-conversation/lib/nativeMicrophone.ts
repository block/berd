function invokeRawBinary(
  command: string,
  payload: Uint8Array,
): Promise<unknown> {
  const internals = (
    window as unknown as {
      __TAURI_INTERNALS__?: {
        invoke?: (command: string, payload: Uint8Array) => Promise<unknown>;
      };
    }
  ).__TAURI_INTERNALS__;
  if (!internals?.invoke) {
    return Promise.reject(new Error("Tauri audio transport is unavailable."));
  }
  return internals.invoke(command, payload);
}

export interface NativeMicrophone {
  setMuted: (muted: boolean) => void;
  stop: () => void;
}

export async function startNativeMicrophone(): Promise<NativeMicrophone> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      sampleRate: 48_000,
    },
  });
  const track = stream.getAudioTracks()[0];
  if (!track) {
    stream.getTracks().forEach((item) => {
      item.stop();
    });
    throw new Error("No microphone input is available.");
  }

  const context = new AudioContext({ sampleRate: 48_000 });
  try {
    if (context.sampleRate !== 48_000) {
      throw new Error(
        `Native voice requires 48 kHz microphone audio; this device opened at ${context.sampleRate} Hz.`,
      );
    }
    if (context.state === "suspended") await context.resume();
    await context.audioWorklet.addModule("/native-voice-worklet.js");
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const worklet = new AudioWorkletNode(context, "native-voice-processor");
    source.connect(worklet);
    worklet.connect(context.destination);
    let transportErrorReported = false;
    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const samples = event.data;
      void invokeRawBinary(
        "push_native_voice_audio",
        new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
      ).catch((error) => {
        if (transportErrorReported) return;
        transportErrorReported = true;
        console.error("[native-voice] Microphone transport failed", error);
      });
    };

    let stopped = false;
    return {
      setMuted: (muted) => {
        if (stopped) return;
        // Keep the capture session and Web Audio graph alive. A disabled audio
        // track emits silence, which pauses recognition without renegotiating
        // the Core Audio route or changing the user's output volume.
        track.enabled = !muted;
      },
      stop: () => {
        if (stopped) return;
        stopped = true;
        worklet.port.onmessage = null;
        worklet.disconnect();
        source.disconnect();
        stream.getTracks().forEach((item) => {
          item.stop();
        });
        void context.close();
      },
    };
  } catch (error) {
    stream.getTracks().forEach((item) => {
      item.stop();
    });
    await context.close();
    throw error;
  }
}
