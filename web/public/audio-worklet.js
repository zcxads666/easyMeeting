class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.buffer = new Float32Array();
    this.frameSize = options.processorOptions?.frameSize || 1600;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channel = input[0];

    // 追加到缓冲
    const tmp = new Float32Array(this.buffer.length + channel.length);
    tmp.set(this.buffer);
    tmp.set(channel, this.buffer.length);
    this.buffer = tmp;

    // 按帧发送
    while (this.buffer.length >= this.frameSize) {
      const frame = this.buffer.slice(0, this.frameSize);
      this.buffer = this.buffer.slice(this.frameSize);
      this.port.postMessage(frame);
    }
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);