/*!
 * pitch-worklet.js — AudioWorklet 采集线程
 *
 * 只做三件事：把麦克风采样装进环形缓冲、按跳帧调用 PitchCore 的 YIN、
 * 把结果带着音频时钟时间戳发回主线程。UI 与绘制完全不在这里。
 *
 * 依赖：pitch-core.js 必须先 addModule 到同一个 AudioWorkletGlobalScope。
 */
/* global PitchCore, AudioWorkletProcessor, registerProcessor, sampleRate, currentFrame */

class PitchScopeProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    var opts = (options && options.processorOptions) || {};
    this.sampleRate = sampleRate;
    this.windowSize = opts.windowSize || 4096;
    this.hopSize = opts.hopSize || 1024;
    this.decimation = opts.decimation || 2;
    this.minFreq = opts.minFreq || 65;
    this.maxFreq = opts.maxFreq || 1100;

    this.analyzer = PitchCore.createAnalyzer({
      minFreq: this.minFreq,
      maxFreq: this.maxFreq,
      decimation: this.decimation,
      threshold: 0.15,
      maxAperiodicity: 0.5
    });

    this.buf = new Float32Array(this.windowSize);
    this.frame = new Float32Array(this.windowSize);
    this.writePos = 0;
    this.filled = 0;
    this.sinceHop = 0;
    this.totalFrames = 0;

    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  handleMessage(msg) {
    if (!msg || msg.type !== "config") return;
    if (msg.minFreq > 0) this.minFreq = msg.minFreq;
    if (msg.maxFreq > 0) this.maxFreq = msg.maxFreq;
    if (msg.windowSize && msg.windowSize !== this.windowSize) {
      this.windowSize = msg.windowSize;
      this.buf = new Float32Array(this.windowSize);
      this.frame = new Float32Array(this.windowSize);
      this.writePos = 0;
      this.filled = 0;
    }
    this.analyzer.configure({
      minFreq: this.minFreq,
      maxFreq: this.maxFreq,
      decimation: this.decimation
    });
    this.port.postMessage({
      type: "config-ack",
      minFreq: this.minFreq,
      maxFreq: this.maxFreq,
      windowMs: (this.windowSize / this.sampleRate) * 1000,
      hopMs: (this.hopSize / this.sampleRate) * 1000
    });
  }

  process(inputs) {
    var input = inputs[0];
    var channel = input && input[0];
    if (!channel || channel.length === 0) return true;

    var n = channel.length;

    for (var i = 0; i < n; i++) {
      this.buf[this.writePos] = channel[i];
      this.writePos = (this.writePos + 1) % this.windowSize;
      if (this.filled < this.windowSize) this.filled++;
    }
    this.totalFrames += n;
    this.sinceHop += n;

    if (this.filled < this.windowSize) return true;
    if (this.sinceHop < this.hopSize) return true;
    this.sinceHop = 0;

    // 环形缓冲展开成连续帧（最旧的样本在 writePos）
    for (var j = 0; j < this.windowSize; j++) {
      this.frame[j] = this.buf[(this.writePos + j) % this.windowSize];
    }

    var result = this.analyzer.analyze(this.frame, this.sampleRate);

    var clip = 0;
    for (var k = 0; k < this.windowSize; k++) {
      if (this.frame[k] > 0.98 || this.frame[k] < -0.98) clip++;
    }

    var windowSec = this.windowSize / this.sampleRate;
    var endTime = currentFrame / this.sampleRate;

    this.port.postMessage({
      type: "pitch",
      t: endTime - windowSec / 2,
      tEnd: endTime,
      f0: result.f0,
      rawF0: result.rawF0,
      aperiodicity: result.aperiodicity,
      confidence: result.confidence,
      rms: result.rms,
      db: result.db,
      clipRatio: clip / this.windowSize,
      windowMs: windowSec * 1000,
      hopMs: (this.hopSize / this.sampleRate) * 1000,
      sampleRate: this.sampleRate
    });

    return true;
  }
}

registerProcessor("pitch-scope", PitchScopeProcessor);
