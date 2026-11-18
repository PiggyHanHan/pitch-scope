/*!
 * pitch-core.js — 音准可视化核心
 *
 * 职责：十二平均律音名映射 + YIN 基频估计 + 轻量平滑。
 * 纯计算，无 DOM、无 Web Audio 依赖，可单独测试。
 *
 * 三种加载方式：
 *   1) 页面 <script>            → window.PitchCore
 *   2) AudioWorklet.addModule   → globalThis.PitchCore（工作线程内独立实例）
 *   3) Node (require)           → module.exports
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PitchCore = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var A4_MIDI = 69;
  var NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  var LETTER_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  function clamp(value, lo, hi) {
    return value < lo ? lo : value > hi ? hi : value;
  }

  /* ---------------- 十二平均律映射 ---------------- */

  function midiToFreq(midi, a4) {
    var ref = a4 || 440;
    return ref * Math.pow(2, (midi - A4_MIDI) / 12);
  }

  function freqToMidi(freq, a4) {
    var ref = a4 || 440;
    return A4_MIDI + 12 * Math.log2(freq / ref);
  }

  function midiToName(midi) {
    var m = Math.round(midi);
    return NOTE_NAMES[((m % 12) + 12) % 12];
  }

  function midiToOctave(midi) {
    return Math.floor(Math.round(midi) / 12) - 1;
  }

  function midiToLabel(midi) {
    var m = Math.round(midi);
    return midiToName(m) + midiToOctave(m);
  }

  function noteToMidi(label) {
    var parsed = /^\s*([A-Ga-g])([#b]?)(-?\d+)\s*$/.exec(String(label));
    if (!parsed) return null;
    var semitone = LETTER_SEMITONES[parsed[1].toUpperCase()];
    if (parsed[2] === "#") semitone += 1;
    else if (parsed[2] === "b") semitone -= 1;
    var midi = (parseInt(parsed[3], 10) + 1) * 12 + semitone;
    return midi >= 0 && midi <= 127 ? midi : null;
  }

  function centsBetween(freq, targetFreq) {
    return 1200 * Math.log2(freq / targetFreq);
  }

  /**
   * 将频率映射到最近的十二平均律音名。
   * @returns {{midi:number, midiFloat:number, cents:number, note:string,
   *           octave:number, label:string, targetFreq:number}}
   */
  function freqToNote(freq, a4) {
    var midiFloat = freqToMidi(freq, a4);
    var midi = Math.round(midiFloat);
    return {
      midi: midi,
      midiFloat: midiFloat,
      cents: (midiFloat - midi) * 100,
      note: midiToName(midi),
      octave: midiToOctave(midi),
      label: midiToLabel(midi),
      targetFreq: midiToFreq(midi, a4)
    };
  }

  function dbFromRms(rms) {
    return 20 * Math.log10(Math.max(rms, 1e-9));
  }

  /* ---------------- YIN 基频估计 ---------------- */

  /**
   * 可复用的 YIN 分析器。
   * 两级策略：降采样粗估（快）+ 原始采样率局部细化（准），
   * 兼顾 C2 的低频周期与 C6 的音分精度。
   */
  function YinAnalyzer(options) {
    this.minFreq = 60;
    this.maxFreq = 1250;
    this.threshold = 0.15;      // YIN 首个候选峰的绝对阈值
    this.maxAperiodicity = 0.30; // 超过则置信度过低
    this.decimation = 2;
    this._size = 0;
    this._decSize = 0;
    this._d = null;
    this._dn = null;
    this._tbl = null;
    this.configure(options || {});
  }

  YinAnalyzer.prototype.configure = function (options) {
    if (!options) return this;
    if (options.minFreq > 0) this.minFreq = options.minFreq;
    if (options.maxFreq > 0) this.maxFreq = options.maxFreq;
    if (options.threshold > 0) this.threshold = options.threshold;
    if (options.maxAperiodicity > 0) this.maxAperiodicity = options.maxAperiodicity;
    if (options.decimation >= 1) this.decimation = Math.round(options.decimation);
    return this;
  };

  YinAnalyzer.prototype._ensure = function (rawSize, decSize, tauMax) {
    if (this._size !== rawSize) {
      this._size = rawSize;
      this._x = new Float32Array(rawSize);
    }
    if (this._decSize !== decSize) {
      this._decSize = decSize;
      this._y = new Float32Array(decSize);
    }
    if (!this._d || this._d.length < tauMax + 2) {
      this._d = new Float32Array(tauMax + 2);
      this._dn = new Float32Array(tauMax + 2);
    }
    if (!this._tbl) this._tbl = new Float64Array(32);
  };

  function invalidResult(rms, aperiodicity, rawF0) {
    return {
      f0: 0,
      rawF0: rawF0 || 0,
      aperiodicity: aperiodicity === undefined ? 1 : aperiodicity,
      confidence: 0,
      rms: rms || 0,
      db: dbFromRms(rms || 0),
      valid: false
    };
  }

  /**
   * 分析一帧时域采样。
   * @param {Float32Array} frame 定长帧（建议 4096 @48k）
   * @param {number} sampleRate
   */
  YinAnalyzer.prototype.analyze = function (frame, sampleRate) {
    var n = frame.length;
    var dec = this.decimation;
    var sr = sampleRate;
    var dsr = sr / dec;

    // 搜索上限比目标上限略宽：先测出真实基频，再由 inRange 判定“超出范围”，
    // 避免 1.4 kHz 这类范围外输入被误读成低八度。
    var searchMax = this.maxFreq * 1.5;
    var tauMin = Math.max(2, Math.floor(dsr / searchMax) - 1);
    var tauMax = Math.min(
      Math.floor(n / dec / 2) - 2,
      Math.ceil(dsr / this.minFreq) + 1
    );

    if (n < 256 || tauMax - tauMin < 4) return invalidResult(0, 1, 0);

    /* 1. 去直流、算 RMS */
    var sum = 0;
    var sumSq = 0;
    for (var i = 0; i < n; i++) {
      var v = frame[i];
      sum += v;
      sumSq += v * v;
    }
    var mean = sum / n;
    var rms = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
    if (rms < 1e-7) return invalidResult(rms, 1, 0);

    var decSize = Math.floor(n / dec);
    this._ensure(n, decSize, tauMax);

    var x = this._x;
    for (i = 0; i < n; i++) x[i] = frame[i] - mean;

    /* 2. 降采样（相邻样本均值，兼作粗低通） */
    var y = this._y;
    for (i = 0; i < decSize; i++) {
      var acc = 0;
      for (var k = 0; k < dec; k++) acc += x[i * dec + k];
      y[i] = acc / dec;
    }

    /* 3. 差分函数 d(tau) */
    var d = this._d;
    var dn = this._dn;
    d[0] = 0;
    for (var tau = 1; tau <= tauMax; tau++) {
      var diffSum = 0;
      var limit = decSize - tau;
      for (var j = 0; j < limit; j++) {
        var delta = y[j] - y[j + tau];
        diffSum += delta * delta;
      }
      d[tau] = diffSum;
    }

    /* 4. 累积均值归一化 d'(tau) */
    var cumulative = 0;
    dn[0] = 1;
    for (tau = 1; tau <= tauMax; tau++) {
      cumulative += d[tau];
      dn[tau] = cumulative > 1e-12 ? (d[tau] * tau) / cumulative : 1;
    }

    /* 5. 取第一个低于阈值的局部极小；否则取全局极小 */
    var pickedTau = -1;
    var aperiodicity = 1;
    for (tau = tauMin; tau <= tauMax - 1; tau++) {
      if (dn[tau] < this.threshold && dn[tau] <= dn[tau - 1] && dn[tau] <= dn[tau + 1]) {
        pickedTau = tau;
        aperiodicity = dn[tau];
        break;
      }
    }
    if (pickedTau < 0) {
      var minVal = Infinity;
      pickedTau = tauMin;
      for (tau = tauMin; tau <= tauMax; tau++) {
        if (dn[tau] < minVal) {
          minVal = dn[tau];
          pickedTau = tau;
        }
      }
      aperiodicity = minVal;
      if (!isFinite(minVal)) return invalidResult(rms, 1, 0);
    }

    /* 6. 原始采样率上的局部细化 */
    var coarseTau = pickedTau * dec;
    var half = Math.max(3, dec + 2);
    var lo = Math.max(2, Math.floor(coarseTau) - half);
    var hi = Math.min(Math.floor(n / 2) - 2, Math.floor(coarseTau) + half);
    if (hi - lo < 2) return invalidResult(rms, aperiodicity, 0);

    var count = hi - lo + 1;
    if (this._tbl.length < count) this._tbl = new Float64Array(count + 2);
    var table = this._tbl;
    var cmpLen = n - hi;
    var bestIndex = 0;
    var bestValue = Infinity;

    for (var t = 0; t < count; t++) {
      var lag = lo + t;
      var lagSum = 0;
      for (var q = 0; q < cmpLen; q++) {
        var dd = x[q] - x[q + lag];
        lagSum += dd * dd;
      }
      table[t] = lagSum;
      if (lagSum < bestValue) {
        bestValue = lagSum;
        bestIndex = t;
      }
    }

    /* 7. 抛物线插值 */
    var offset = 0;
    if (bestIndex > 0 && bestIndex < count - 1) {
      var a = table[bestIndex - 1];
      var b = table[bestIndex];
      var c = table[bestIndex + 1];
      var denom = a - 2 * b + c;
      if (Math.abs(denom) > 1e-12) {
        offset = 0.5 * (a - c) / denom;
        offset = clamp(offset, -0.5, 0.5);
      }
    }

    var refinedTau = lo + bestIndex + offset;
    var rawF0 = sr / refinedTau;
    var inRange = rawF0 >= this.minFreq && rawF0 <= this.maxFreq;
    var confidence = clamp(1 - aperiodicity, 0, 1);
    var valid = inRange && aperiodicity <= this.maxAperiodicity;

    return {
      f0: inRange ? rawF0 : 0,
      rawF0: rawF0,
      aperiodicity: aperiodicity,
      confidence: confidence,
      rms: rms,
      db: dbFromRms(rms),
      valid: valid
    };
  };

  function createAnalyzer(options) {
    return new YinAnalyzer(options || {});
  }

  /** 便捷函数：一次性分析（测试与非高频路径使用）。 */
  function yin(frame, sampleRate, options) {
    return new YinAnalyzer(options || {}).analyze(frame, sampleRate);
  }

  /* ---------------- 平滑 ---------------- */

  /**
   * 中值 + 指数平滑（都在对数频率域，等价于音分域）。
   * 用于抑制 YIN 偶发的倍频/半频跳变，同时不掩盖真实的滑音。
   */
  function PitchSmoother(options) {
    this.medianSize = 1;
    this.tauMs = 0;
    this._vals = [];
    this._log = null;
    this._lastT = null;
    this._lastDt = 16;
    this.configure(options || {});
    this.reset();
  }

  PitchSmoother.prototype.configure = function (options) {
    if (!options) return this;
    if (options.medianSize >= 1) this.medianSize = Math.round(options.medianSize);
    if (options.tauMs >= 0) this.tauMs = options.tauMs;
    return this;
  };

  PitchSmoother.prototype.reset = function () {
    this._vals = [];
    this._log = null;
    this._lastT = null;
    this._suspect = 0;
  };

  PitchSmoother.prototype.push = function (f0, timeMs) {
    if (!(f0 > 0) || !isFinite(f0)) {
      this.reset();
      return null;
    }
    if (this._lastT !== null) {
      var gap = timeMs - this._lastT;
      if (gap > 300) this.reset();
      if (gap > 0) this._lastDt = gap;
    }
    this._lastT = timeMs;

    var value = Math.log2(f0);
    var vals = this._vals;
    vals.push(value);
    while (vals.length > this.medianSize) vals.shift();

    var sorted = vals.slice().sort(function (a, b) { return a - b; });
    var median = sorted[Math.floor(sorted.length / 2)];

    if (this._log === null) {
      this._log = median;
      this._suspect = 0;
      return Math.pow(2, this._log);
    }

    // 倍频/半频保护：单帧跳变超过约 6 个半音先保持旧值，
    // 连续两帧成立才接受，避免把一次误检画进曲线。
    var jump = median - this._log;
    if (Math.abs(jump) > 0.5) {
      this._suspect += 1;
      if (this._suspect < 2) return Math.pow(2, this._log);
      this._log = median;
      this._suspect = 0;
      return Math.pow(2, this._log);
    }
    this._suspect = 0;

    if (this.tauMs > 0) {
      var alpha = 1 - Math.exp(-this._lastDt / this.tauMs);
      this._log += alpha * (median - this._log);
    } else {
      this._log = median;
    }
    return Math.pow(2, this._log);
  };

  return {
    version: "1.0.0",
    A4_MIDI: A4_MIDI,
    NOTE_NAMES: NOTE_NAMES,
    clamp: clamp,
    midiToFreq: midiToFreq,
    freqToMidi: freqToMidi,
    midiToName: midiToName,
    midiToOctave: midiToOctave,
    midiToLabel: midiToLabel,
    noteToMidi: noteToMidi,
    centsBetween: centsBetween,
    freqToNote: freqToNote,
    dbFromRms: dbFromRms,
    YinAnalyzer: YinAnalyzer,
    createAnalyzer: createAnalyzer,
    yin: yin,
    PitchSmoother: PitchSmoother
  };
});
