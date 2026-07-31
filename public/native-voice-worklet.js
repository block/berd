class NativeVoiceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(960);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    let sourceOffset = 0;
    while (sourceOffset < input.length) {
      const count = Math.min(
        input.length - sourceOffset,
        this.buffer.length - this.offset,
      );
      this.buffer.set(
        input.subarray(sourceOffset, sourceOffset + count),
        this.offset,
      );
      this.offset += count;
      sourceOffset += count;
      if (this.offset === this.buffer.length) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(960);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("native-voice-processor", NativeVoiceProcessor);
