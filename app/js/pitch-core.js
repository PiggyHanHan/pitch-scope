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
    this.threshold = 0.15;       // YIN 候选凹陷的绝对阈值
    this.maxAperiodicity = 0.30; // 超过则置信度过低
    this.decimation = 2;

    // 八度族选峰参数（见 _pickTau 注释）
    this.octaveSlack = 0.10;    // 更短周期的凹陷允许比最深凹陷浅多少
    this.octaveMaxDepth = 0.30; // 最深凹陷超过这个值就认为整帧不够周期，不做归一
    this.octaveHarmonics = 4;   // 向下检查 bestTau / k，k = 2..4（八度族 + 三倍）
    this.octaveMinConfidence = 0.25; // 更短周期本身得「够可信」才允许归一

    this._size = 0;
    this._decSize = 0;
    this._d = null;
    this._dn = null;
    this._cand = null;
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
    if (options.octaveSlack >= 0) this.octaveSlack = options.octaveSlack;
    if (options.octaveMaxDepth > 0) this.octaveMaxDepth = options.octaveMaxDepth;
    if (options.octaveHarmonics >= 2) this.octaveHarmonics = Math.round(options.octaveHarmonics);
    if (options.octaveMinConfidence > 0) this.octaveMinConfidence = options.octaveMinConfidence;
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
      this._cand = new Int32Array(tauMax + 2);
    }
    if (!this._tbl) this._tbl = new Float64Array(32);
  };

  /**
   * 从 d'(τ) 里挑出真实周期（八度族选峰的入口）。
   *
   * 为什么不能沿用经典 YIN 的「第一个低于阈值的局部极小」：
   * 真实人声在换字、气声、尾音处，基频凹陷会变浅（d'(T) > 0.15），
   * 而 2T / 3T / 4T 处的凹陷反而更深（d'(2T) < 0.15），
   * 于是规则会跳过一个八度甚至两个八度 —— 这正是曲线上的上下尖峰。
   *
   * 判据用一条不对称的事实：任何以 T 为周期的信号必然也以 2T、3T、4T 为周期，
   * 反过来不成立。所以更长的 lag 只有在更短的 lag 不成立时才有意义。
   *
   * 三级规则：
   *   1) 倍数归一：先取最深凹陷 best，若 best/k（k = 2..octaveHarmonics）附近存在
   *      「深度不超过 best + octaveSlack」的凹陷，说明 best 只是 best/k 的倍数，
   *      取最短的那个。真正含次谐波（气泡音 / 低八度伴唱）的帧里 best 会显著深于
   *      best/2（差距远大于 octaveSlack），这条判据正好把它排除在外。
   *   2) 经典规则：否则取最短的「干净」凹陷（d' ≤ threshold），这样纯音、干净的
   *      乐音不受影响 —— 注意纯正弦的各个 kT 凹陷深度几乎相同，若只按「最深」
   *      取峰会因为数值误差落到 3T、5T 上。
   *   3) 退化：都没有时取最深凹陷；若它落在搜索下限附近（窗内没有真实周期：
   *      换字 / 气口 / 跨两个音），判为无效，不再输出 B1/C2 附近的值。
   */
  YinAnalyzer.prototype._pickTau = function (dn, tauMin, tauMax) {
    if (!this._cand || this._cand.length < tauMax + 2) this._cand = new Int32Array(tauMax + 2);
    var cand = this._cand;
    var nCand = 0;
    var tau;

    for (tau = tauMin; tau <= tauMax - 1; tau++) {
      if (dn[tau] <= dn[tau - 1] && dn[tau] <= dn[tau + 1]) cand[nCand++] = tau;
    }

    var bestTau = -1;
    var bestVal = Infinity;
    var ci;

    if (nCand > 0) {
      for (ci = 0; ci < nCand; ci++) {
        var value = dn[cand[ci]];
        if (value < bestVal) { bestVal = value; bestTau = cand[ci]; }
      }
    } else {
      // 没有任何局部极小：整段退化，取全局最小。
      for (tau = tauMin; tau <= tauMax; tau++) {
        if (dn[tau] < bestVal) { bestVal = dn[tau]; bestTau = tau; }
      }
      if (!isFinite(bestVal)) return { ok: false, aperiodicity: 1 };

      // 退化解落在搜索下限附近，说明窗内没有真实周期（换字 / 气口 / 跨界），
      // 这时输出的是搜索边界值，对任何真实人声都没有意义。
      if (bestTau > tauMax - 3) return { ok: false, aperiodicity: bestVal };
      return { ok: true, tau: bestTau, aperiodicity: bestVal };
    }

    var pickedTau = -1;
    var pickedVal = Infinity;
    var ci2;

    /* 1) 经典规则：最短的「干净」凹陷（d' ≤ threshold）。
     *    纯音、干净的乐音走这条分支，行为与旧版一致。 */
    for (ci2 = 0; ci2 < nCand; ci2++) {
      if (dn[cand[ci2]] <= this.threshold) {
        pickedTau = cand[ci2];
        pickedVal = dn[cand[ci2]];
        break;
      }
    }

    /* 2) 没有干净凹陷：只有「够可信」的最深凹陷才用，否则判为无可信周期。
     *    旧版在这里退化成「全段全局最小」，于是气口 / 换字帧会被推到搜索下限，
     *    输出固定的 63.49 Hz（B1/C2）；现在直接判无效，rawF0 = 0。 */
    if (pickedTau < 0) {
      if (bestVal > this.octaveMaxDepth) return { ok: false, aperiodicity: bestVal };
      if (bestTau > tauMax - 3) return { ok: false, aperiodicity: bestVal };
      pickedTau = bestTau;
      pickedVal = bestVal;
    }

    /* 3) 八度族归一：如果选中的 τ 其实是某个更短周期的倍数 —— 也就是更短周期处
     *    的凹陷虽然比它浅、但没有浅过 octaveSlack —— 就把 τ 换成更短的那个。
     *    两个限制：
     *      - 更短周期本身的凹陷要「够可信」（aperiodicity ≤ 1 - octaveMinConfidence，
     *        默认 0.25，也就是页面默认置信度门限），否则宁可不改 —— 不可信帧上
     *        「哪个数」都无所谓，改成更高的音只会把越界读数变多；
     *      - 只对「浅到够不上 threshold」的更短候选生效：真正更干净的短周期在第 1
     *        步就已经被选中，所以这一步不会把纯音、干净乐音改到更短的周期上。 */
    var shorterLimit = Math.min(this.octaveMaxDepth, 1 - this.octaveMinConfidence);
    if (pickedVal <= this.octaveMaxDepth) {
      for (var pass = 0; pass < 3; pass++) {
        var limit = Math.min(pickedVal + this.octaveSlack, shorterLimit);
        var shorterTau = -1;
        var shorterVal = Infinity;
        for (var k = this.octaveHarmonics; k >= 2; k--) {
          var target = pickedTau / k;
          if (target < tauMin) continue;
          var span = Math.max(1, Math.round(target * 0.04));
          for (var cj = 0; cj < nCand; cj++) {
            var ct = cand[cj];
            if (ct >= pickedTau) continue;
            if (Math.abs(ct - target) > span) continue;
            if (dn[ct] > limit || dn[ct] >= shorterVal) continue;
            shorterTau = ct;
            shorterVal = dn[ct];
          }
        }
        if (shorterTau < 0) break;
        pickedTau = shorterTau;
        pickedVal = shorterVal;
      }
    }

    return { ok: true, tau: pickedTau, aperiodicity: pickedVal };
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

    /* 5. 八度族选峰 */
    var picked = this._pickTau(dn, tauMin, tauMax);
    if (!picked.ok) return invalidResult(rms, picked.aperiodicity, 0);
    var pickedTau = picked.tau;
    var aperiodicity = picked.aperiodicity;

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
   *
   * 跳变确认带迟滞：普通大跳变（音阶、级进、滑音）2 帧即接受，
   * 落在整八度附近的跳变要求 3 帧（≈64 ms）连续成立才接受 ——
   * 八度族误判通常只持续 1–2 帧，而真实的八度跳唱是持续的。
   */
  function PitchSmoother(options) {
    this.medianSize = 1;
    this.tauMs = 0;
    this.jumpSemitones = 6;      // 超过这个幅度视为跳变
    this.octaveBandSemitones = 3; // 与整八度的偏差在此以内算「八度族跳变」
    this.jumpConfirm = 2;        // 普通跳变需要的连续帧数
    this.octaveConfirm = 3;      // 八度族跳变需要的连续帧数
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
    if (options.jumpSemitones > 0) this.jumpSemitones = options.jumpSemitones;
    if (options.octaveBandSemitones >= 0) this.octaveBandSemitones = options.octaveBandSemitones;
    if (options.jumpConfirm >= 1) this.jumpConfirm = Math.round(options.jumpConfirm);
    if (options.octaveConfirm >= 1) this.octaveConfirm = Math.round(options.octaveConfirm);
    return this;
  };

  PitchSmoother.prototype.reset = function () {
    this._vals = [];
    this._log = null;
    this._lastT = null;
    this._suspect = 0;
  };

  /** 跳变是否落在整八度（含 2、3 个八度）附近。 */
  PitchSmoother.prototype.isOctaveJump = function (jumpOctaves) {
    var magnitude = Math.abs(jumpOctaves);
    if (magnitude < 1 - this.octaveBandSemitones / 12) return false;
    var nearest = Math.round(magnitude);
    return Math.abs(magnitude - nearest) * 12 <= this.octaveBandSemitones;
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
    // 连续成立才接受，避免把一次误检画进曲线。
    var jump = median - this._log;
    var jumpSemitones = Math.abs(jump) * 12;
    if (jumpSemitones > this.jumpSemitones) {
      var need = this.isOctaveJump(jump) ? this.octaveConfirm : this.jumpConfirm;
      this._suspect += 1;
      if (this._suspect < need) return Math.pow(2, this._log);
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

  /* ---------------- 逐帧状态机 ---------------- */

  /**
   * PitchTracker：把「一帧 YIN 结果」变成「界面该显示什么」。
   *
   * 从 app.js 里抽出来的原因：它决定曲线画什么、读数是否闪成「—」，
   * 是八度尖峰的放大器之一（旧版任一帧低置信度就 reset 平滑器，
   * 而 reset 后的第一帧会被无条件接受）。放在这里可以在 Node 里
   * 用真实录音逐帧回归，而不需要浏览器。
   *
   * 输入的 msg 字段：f0 / rawF0 / aperiodicity / confidence / db / clipRatio / t / tEnd（秒）。
   * 返回：{ status, current, point, held }
   *   point 非空时表示曲线应新增一个点。
   */
  function PitchTracker(options) {
    this.a4 = 440;
    this.minMidi = 36;
    this.maxMidi = 84;
    this.gateDb = -60;
    this.confidence = 0.75;
    this.clipLimit = 0.05;
    this.holdMs = 150;       // 低置信度单帧的读数保持时间
    this.smoothing = { medianSize: 3, tauMs: 30 };
    this.smoother = new PitchSmoother(this.smoothing);
    this.current = null;
    this.status = "idle";
    this._lastGoodT = null;
    this.configure(options || {});
  }

  PitchTracker.prototype.configure = function (options) {
    if (!options) return this;
    if (options.a4 > 0) this.a4 = options.a4;
    if (options.minMidi > 0) this.minMidi = options.minMidi;
    if (options.maxMidi > 0) this.maxMidi = options.maxMidi;
    if (options.gateDb < 0) this.gateDb = options.gateDb;
    if (options.confidence > 0) this.confidence = options.confidence;
    if (options.clipLimit >= 0) this.clipLimit = options.clipLimit;
    if (options.holdMs >= 0) this.holdMs = options.holdMs;
    if (options.smoothing) {
      this.smoothing = options.smoothing;
      this.smoother.configure(options.smoothing);
      if (options.resetSmoother === true) this.smoother.reset();
    }
    return this;
  };

  PitchTracker.prototype.reset = function () {
    this.smoother.reset();
    this.current = null;
    this._lastGoodT = null;
  };

  PitchTracker.prototype._classify = function (msg) {
    if (msg.clipRatio > this.clipLimit) return "overload";
    if (!(msg.db >= this.gateDb)) return "no-signal";
    if (!(msg.rawF0 > 0) || !(msg.aperiodicity <= 1 - this.confidence)) return "low-confidence";
    var midiFloat = freqToMidi(msg.rawF0, this.a4);
    if (midiFloat < this.minMidi - 0.35 || midiFloat > this.maxMidi + 0.35) return "out-of-range";
    return "detecting";
  };

  PitchTracker.prototype.track = function (msg) {
    var status = this._classify(msg);

    if (status !== "detecting") {
      // 单帧低置信度（气口、换字、毛刺）不清空平滑历史，读数保持一小段时间：
      // 否则 reset 后的第一帧会被无条件接受，正好把一次八度误判画成尖峰。
      var holding = status === "low-confidence" &&
        this.current !== null &&
        this._lastGoodT !== null &&
        (msg.t - this._lastGoodT) * 1000 <= this.holdMs;

      if (holding) {
        this.status = "detecting";
        return { status: this.status, current: this.current, point: null, held: true };
      }

      this.smoother.reset();
      this.current = null;
      this.status = status;
      return { status: status, current: null, point: null, held: false };
    }

    var smoothF0 = this.smoother.push(msg.f0, msg.t * 1000);
    if (!smoothF0) {
      this.current = null;
      this.status = "low-confidence";
      return { status: this.status, current: null, point: null, held: false };
    }

    var note = freqToNote(smoothF0, this.a4);
    if (note.midiFloat < this.minMidi - 0.5 || note.midiFloat > this.maxMidi + 0.5) {
      this.current = null;
      this.status = "out-of-range";
      return { status: this.status, current: null, point: null, held: false };
    }

    this.current = {
      f0: smoothF0,
      rawF0: msg.f0,
      t: msg.t,
      midiFloat: note.midiFloat,
      note: note.note,
      octave: note.octave,
      label: note.label,
      cents: note.cents,
      targetFreq: note.targetFreq,
      confidence: msg.confidence
    };
    this._lastGoodT = msg.t;
    this.status = "detecting";
    return {
      status: this.status,
      current: this.current,
      point: { t: msg.t, midi: note.midiFloat },
      held: false
    };
  };

  function createTracker(options) {
    return new PitchTracker(options || {});
  }

  return {
    version: "1.1.0",
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
    PitchSmoother: PitchSmoother,
    PitchTracker: PitchTracker,
    createTracker: createTracker
  };
});
