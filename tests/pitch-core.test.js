#!/usr/bin/env node
/*!
 * pitch-core.test.js — 音高检测核心的可复现测试
 *
 * 运行：node tests/pitch-core.test.js
 * 只依赖 Node 标准库，不需要安装任何包。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const PC = require("../app/js/pitch-core.js");

const SAMPLE_RATE = 48000;
const WINDOW = 4096;
const HOP = 1024;

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  PASS  " + name);
  } catch (err) {
    failed++;
    failures.push({ name, message: err.message });
    console.log("  FAIL  " + name);
    console.log("        " + err.message);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "断言失败");
}

function approx(actual, expected, tolerance, label) {
  const delta = Math.abs(actual - expected);
  if (!(delta <= tolerance)) {
    throw new Error(
      `${label || "数值"}：期望 ${expected} ± ${tolerance}，实际 ${actual}（差 ${delta}）`
    );
  }
}

function sine(freq, sampleRate, seconds, amplitude, phase) {
  const n = Math.round(sampleRate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = (amplitude === undefined ? 0.25 : amplitude) *
      Math.sin(2 * Math.PI * freq * (i / sampleRate) + (phase || 0));
  }
  return out;
}

/** 以 4096 / 1024 的窗口跳帧完整分析一段音频，返回逐帧结果。 */
function analyzeSignal(signal, options) {
  const analyzer = PC.createAnalyzer(Object.assign({
    minFreq: 60,
    maxFreq: 1250,
    decimation: 2
  }, options || {}));
  const frames = [];
  for (let offset = 0; offset + WINDOW <= signal.length; offset += HOP) {
    const frame = signal.subarray(offset, offset + WINDOW);
    const res = analyzer.analyze(frame, SAMPLE_RATE);
    frames.push(Object.assign({ offset }, res));
  }
  return frames;
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, p) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

console.log("\n音准可视化 · 核心算法测试");
console.log("采样率 " + SAMPLE_RATE + " Hz · 窗口 " + WINDOW + " · 跳帧 " + HOP);
console.log("------------------------------------------------------------\n");

/* ================= 1. 十二平均律音名映射 ================= */

console.log("[1] 音名映射");

test("A4 = 440 Hz 精确映射为 A4 / 0 cents", () => {
  const note = PC.freqToNote(440, 440);
  assert(note.label === "A4", "音名应为 A4，实际 " + note.label);
  assert(note.octave === 4, "八度应为 4");
  approx(note.cents, 0, 0.001, "音分");
  approx(note.targetFreq, 440, 0.001, "目标音频率");
});

test("C4 = 261.6256 Hz 映射为 C4", () => {
  const note = PC.freqToNote(261.625565, 440);
  assert(note.label === "C4", "音名应为 C4，实际 " + note.label);
  approx(note.cents, 0, 0.01, "音分");
});

test("D4 偏高 8 cents 的示例", () => {
  const d4 = PC.midiToFreq(62, 440);
  const detuned = d4 * Math.pow(2, 8 / 1200);
  const note = PC.freqToNote(detuned, 440);
  assert(note.label === "D4", "音名应为 D4");
  approx(note.cents, 8, 0.01, "音分");
});

test("音分公式：1200 * log2(f / f0)", () => {
  approx(PC.centsBetween(880, 440), 1200, 0.0001, "倍频程");
  approx(PC.centsBetween(440, 440), 0, 0.0001, "同音");
  approx(PC.centsBetween(466.163762, 440), 100, 0.001, "半音");
});

test("MIDI ↔ 音名（含升号与八度边界）", () => {
  assert(PC.midiToLabel(60) === "C4", "MIDI 60 应为 C4");
  assert(PC.midiToLabel(61) === "C#4", "MIDI 61 应为 C#4");
  assert(PC.midiToLabel(84) === "C6", "MIDI 84 应为 C6");
  assert(PC.midiToLabel(36) === "C2", "MIDI 36 应为 C2");
  assert(PC.midiToLabel(59) === "B3", "MIDI 59 应为 B3");
  assert(PC.noteToMidi("A#3") === 58, "A#3 应为 MIDI 58");
  assert(PC.noteToMidi("C4") === 60, "C4 应为 MIDI 60");
  assert(PC.noteToMidi("Bb3") === 58, "Bb3 应为 MIDI 58");
  assert(PC.noteToMidi("H4") === null, "非法音名应返回 null");
});

test("A4 可配置：A4 = 432 Hz 时映射整体平移", () => {
  const a4 = PC.freqToNote(432, 432);
  assert(a4.label === "A4", "432 Hz 应为 A4，实际 " + a4.label);
  approx(a4.cents, 0, 0.001, "音分");

  // 440 Hz 在 A4=432 体系里等于 A4 上方 31.7 cents
  const shifted = PC.freqToNote(440, 432);
  assert(shifted.label === "A4", "440 Hz 在 432 体系下仍应取最近音 A4");
  approx(shifted.cents, 1200 * Math.log2(440 / 432), 0.01, "音分");

  // C4 的物理频率随 A4 改变
  approx(PC.midiToFreq(60, 432), 256.87, 0.02, "C4 频率");
});

/* ================= 2. YIN 基频检测精度 ================= */

console.log("\n[2] YIN 检测精度（标准正弦音）");

const NOTES = [
  { label: "C2", midi: 36 },
  { label: "C3", midi: 48 },
  { label: "C4", midi: 60 },
  { label: "D4", midi: 62 },
  { label: "E4", midi: 64 },
  { label: "G4", midi: 67 },
  { label: "A4", midi: 69 },
  { label: "B4", midi: 71 },
  { label: "C5", midi: 72 },
  { label: "C6", midi: 84 }
];

const noteAccuracy = {};

NOTES.forEach((item) => {
  const freq = PC.midiToFreq(item.midi, 440);
  const frames = analyzeSignal(sine(freq, SAMPLE_RATE, 2.2, 0.28));
  const valid = frames.filter((f) => f.valid);

  test(`${item.label}（${freq.toFixed(1)} Hz）检测准确`, () => {
    assert(valid.length / frames.length > 0.95,
      `有效率过低：${valid.length}/${frames.length}`);

    const f0s = valid.map((f) => f.f0);
    const med = median(f0s);
    const errCents = Math.abs(PC.centsBetween(med, freq));
    noteAccuracy[item.label] = { freq, med, errCents };

    assert(errCents < 2.5, `${item.label} 中位频率误差 ${errCents.toFixed(2)} cents（> 2.5）`);
    approx(med, freq, freq * 0.002, `${item.label} 中位频率`);
  });
});

test("所有测试音的音分误差 P95 < 5 cents", () => {
  NOTES.forEach((item) => {
    const freq = PC.midiToFreq(item.midi, 440);
    const frames = analyzeSignal(sine(freq, SAMPLE_RATE, 2.2, 0.28));
    const errors = frames.filter((f) => f.valid)
      .map((f) => Math.abs(PC.centsBetween(f.f0, freq)));
    const p95 = percentile(errors, 0.95);
    assert(p95 < 5, `${item.label} P95 = ${p95.toFixed(2)} cents`);
  });
});

test("检测频率映射出的音名与八度正确", () => {
  NOTES.forEach((item) => {
    const freq = PC.midiToFreq(item.midi, 440);
    const frames = analyzeSignal(sine(freq, SAMPLE_RATE, 1.2, 0.25)).filter((f) => f.valid);
    const labels = frames.map((f) => PC.freqToNote(f.f0, 440).label);
    const correct = labels.filter((label) => label === item.label).length / labels.length;
    assert(correct > 0.98,
      `${item.label} 音名命中比例 ${(correct * 100).toFixed(1)}%`);
  });
});

test("±5 cents 的标准音稳定落在同一音名附近", () => {
  const target = PC.midiToFreq(62, 440); // D4
  [0, -5, 5].forEach((offset) => {
    const freq = target * Math.pow(2, offset / 1200);
    const frames = analyzeSignal(sine(freq, SAMPLE_RATE, 1.5, 0.25)).filter((f) => f.valid);
    const notes = frames.map((f) => PC.freqToNote(f.f0, 440));
    const labels = notes.map((n) => n.label);
    assert(labels.every((l) => l === "D4"), `${offset} cents 偏移时音名应保持 D4`);
    const medCents = median(notes.map((n) => n.cents));
    approx(medCents, offset, 1.2, `${offset} cents 的音分读数`);
  });
});

/* ================= 3. 边界与异常输入 ================= */

console.log("\n[3] 边界情况");

test("无声（全零）不产出音高", () => {
  const frames = analyzeSignal(new Float32Array(SAMPLE_RATE * 1.5));
  frames.forEach((f) => {
    assert(f.f0 === 0, "静音不应返回基频");
    assert(f.valid === false, "静音不应有效");
  });
});

test("白噪声不产生稳定音名", () => {
  let seed = 20261118;
  const n = SAMPLE_RATE * 2;
  const noise = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    noise[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.18;
  }
  const frames = analyzeSignal(noise);
  const validRatio = frames.filter((f) => f.valid).length / frames.length;
  const lowConfRatio = frames.filter((f) => f.confidence < 0.5).length / frames.length;
  assert(validRatio < 0.05, `噪声有效率 ${(validRatio * 100).toFixed(1)}%，应 < 5%`);
  assert(lowConfRatio > 0.9, `噪声低置信度比例 ${(lowConfRatio * 100).toFixed(1)}%，应 > 90%`);
});

test("低音量正弦仍可测，但 RMS 正确反映电平", () => {
  const frames = analyzeSignal(sine(440, SAMPLE_RATE, 1.2, 0.004)).filter((f) => f.valid);
  assert(frames.length > 0, "低音量仍应能测到基频");
  const db = median(frames.map((f) => f.db));
  const expected = 20 * Math.log10(0.004 / Math.SQRT2);
  approx(db, expected, 0.5, "低音量 RMS dB");
  assert(db < -45, "0.004 振幅应低于 -45 dBFS，交给界面判定信号不足");
});

test("超出检测范围的频率被拒绝", () => {
  const low = analyzeSignal(sine(40, SAMPLE_RATE, 1.5, 0.3), { minFreq: 65, maxFreq: 1250 });
  assert(low.every((f) => f.f0 === 0), "40 Hz 应被检测范围拒绝");

  const high = analyzeSignal(sine(1400, SAMPLE_RATE, 1.5, 0.3), { minFreq: 65, maxFreq: 1250 });
  assert(high.every((f) => f.f0 === 0), "1400 Hz 应被检测范围拒绝");
});

test("滑音（A3 → A4）被连续跟踪，无跳 octave", () => {
  const seconds = 2.0;
  const n = Math.round(SAMPLE_RATE * seconds);
  const signal = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const progress = i / n;
    const freq = 220 * Math.pow(2, progress); // 220 -> 440
    phase += 2 * Math.PI * freq / SAMPLE_RATE;
    signal[i] = 0.26 * Math.sin(phase);
  }
  const frames = analyzeSignal(signal).filter((f) => f.valid);
  assert(frames.length / (signal.length / HOP) > 0.9, "滑音有效率过低");

  // 每帧音高应落在该时刻 ±60 cents 内，且无 2 倍频错误
  let bad = 0;
  frames.forEach((f) => {
    const progress = f.offset / n;
    const expect = 220 * Math.pow(2, progress);
    const cents = PC.centsBetween(f.f0, expect);
    if (Math.abs(cents) > 60) bad++;
  });
  assert(bad / frames.length < 0.03, `滑音跟踪异常帧比例 ${(bad / frames.length * 100).toFixed(1)}%`);
});

test("振动音（±25 cents / 6 Hz）音高变化被保留", () => {
  const seconds = 1.6;
  const n = Math.round(SAMPLE_RATE * seconds);
  const signal = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const freq = 440 * Math.pow(2, (25 / 1200) * Math.sin(2 * Math.PI * 6 * t));
    phase += 2 * Math.PI * freq / SAMPLE_RATE;
    signal[i] = 0.25 * Math.sin(phase);
  }
  const frames = analyzeSignal(signal).filter((f) => f.valid);
  const cents = frames.map((f) => PC.centsBetween(f.f0, 440));
  const spread = percentile(cents, 0.95) - percentile(cents, 0.05);
  assert(spread > 30, `振动幅度应保留（实测跨度 ${spread.toFixed(1)} cents）`);
});

test("谐波叠加的 G4 不跳到高八度", () => {
  // 基频 + 2~12 次谐波（衰减幅度），模拟人声/乐器频谱
  const seconds = 1.6;
  const n = Math.round(SAMPLE_RATE * seconds);
  const signal = new Float32Array(n);
  const f0 = PC.midiToFreq(67, 440);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 1; k <= 12; k++) {
      if (k * f0 > SAMPLE_RATE / 2) break;
      v += (1 / k) * Math.sin(2 * Math.PI * k * f0 * (i / SAMPLE_RATE));
    }
    signal[i] = 0.055 * v;
  }
  const frames = analyzeSignal(signal).filter((f) => f.valid);
  assert(frames.length > 20, "谐波音有效帧过少");
  const med = median(frames.map((f) => f.f0));
  const err = Math.abs(PC.centsBetween(med, f0));
  assert(err < 3, `谐波音中位误差 ${err.toFixed(2)} cents`);
  const labels = frames.map((f) => PC.freqToNote(f.f0, 440).label);
  assert(labels.every((l) => l === "G4"), "谐波音被误判为其他音名: " + labels[0]);
});

/* ================= 4. 平滑器 ================= */

console.log("\n[4] 平滑与跳变抑制");

test("中值滤波抑制单帧倍频跳变", () => {
  const smoother = new PC.PitchSmoother({ medianSize: 3, tauMs: 0 });
  const outputs = [];
  [440, 880, 440, 440, 440].forEach((f0, i) => {
    outputs.push(smoother.push(f0, i * 21));
  });
  // 第二帧（880）应被中值滤掉
  assert(Math.abs(outputs[1] - 440) < 1, `倍频跳变未被抑制：${outputs[1]}`);
  assert(Math.abs(outputs[4] - 440) < 1, `稳态应回到 440：${outputs[4]}`);
});

test("长间隔后平滑器重置，不被旧音拖住", () => {
  const smoother = new PC.PitchSmoother({ medianSize: 3, tauMs: 30 });
  smoother.push(440, 0);
  smoother.push(440, 21);
  const out = smoother.push(880, 500);
  approx(out, 880, 1.5, "重置后第一帧");
});

test("平滑配置可关闭", () => {
  const smoother = new PC.PitchSmoother({ medianSize: 1, tauMs: 0 });
  approx(smoother.push(441.5, 0), 441.5, 0.001, "关闭平滑时直通");
});

test("八度跳变需要 3 帧确认，2 帧的毛刺不改变读数", () => {
  const smoother = new PC.PitchSmoother({ medianSize: 1, tauMs: 0 });
  const g4 = PC.midiToFreq(67, 440);
  const g5 = PC.midiToFreq(79, 440);

  // 稳态 G4
  let t = 0;
  let out = null;
  for (let i = 0; i < 5; i++) {
    out = smoother.push(g4, (t += 21));
    approx(out, g4, 0.5, "稳态");
  }

  // 2 帧跳到 G5：不应被接受
  smoother.push(g5, (t += 21));
  out = smoother.push(g5, (t += 21));
  approx(out, g4, 0.5, "2 帧的八度毛刺应被挡住");

  // 持续到第 3 帧才接受（≈64 ms，满足 100 ms 内跟上）
  out = smoother.push(g5, (t += 21));
  approx(out, g5, 0.5, "第 3 帧应接受真实的八度跳唱");
});

test("非八度的普通大跳变仍然 2 帧即接受", () => {
  const smoother = new PC.PitchSmoother({ medianSize: 1, tauMs: 0 });
  const a3 = PC.midiToFreq(57, 440);
  const e4 = PC.midiToFreq(64, 440); // +7 半音（纯五度），不是整八度
  let t = 0;
  for (let i = 0; i < 3; i++) smoother.push(a3, (t += 21));
  smoother.push(e4, (t += 21));
  const out = smoother.push(e4, (t += 21));
  approx(out, e4, 0.5, "7 半音的跳进应在 2 帧内跟上");
});

/* ================= 5. 八度族选峰（本次修复） ================= */

console.log("\n[5] 八度族选峰规则");

/** 直接给 _pickTau 喂一个 d'(τ) 曲线：dips = {tau: value}，其余为接近 1 的平台。 */
function pickFromDips(dips, tauMax) {
  const max = tauMax || 400;
  const dn = new Float32Array(max + 2).fill(0.98);
  Object.keys(dips).forEach((tau) => { dn[Number(tau)] = dips[tau]; });
  // 让每个凹陷成为局部极小：相邻 lag 给一个略高的值
  Object.keys(dips).forEach((tau) => {
    const t = Number(tau);
    if (t - 1 > 0 && !(t - 1 in dips)) dn[t - 1] = Math.min(dips[tau] + 0.25, 0.99);
    if (t + 1 <= max && !(t + 1 in dips)) dn[t + 1] = Math.min(dips[tau] + 0.25, 0.99);
  });
  const analyzer = PC.createAnalyzer({ minFreq: 60, maxFreq: 1250, decimation: 2 });
  return analyzer._pickTau(dn, 8, max);
}

test("真实周期凹陷变浅、2T 更深时，不落到低八度", () => {
  // 取自现场录音 3.413 s 的实测值：τ(真实) = 90 → d' = 0.223，τ(2T) = 181 → d' = 0.140
  const picked = pickFromDips({ 90: 0.223, 181: 0.140, 272: 0.309, 364: 0.338 });
  assert(picked.ok, "应给出结果");
  assert(picked.tau === 90, `应选 90，实际 ${picked.tau}`);
  approx(picked.aperiodicity, 0.223, 0.001, "aperiodicity 应为真实周期处的值");
});

test("真实次谐波（2T 远深于 T）不被误改高", () => {
  // 气泡音 / 低八度伴唱：信号真的是 2T 周期，T 只是「半个周期」
  const picked = pickFromDips({ 90: 0.28, 181: 0.01 });
  assert(picked.ok, "应给出结果");
  assert(picked.tau === 181, `应保留 2T（181），实际 ${picked.tau}`);
});

test("干净的纯音仍取最短周期，不落到 kT 上", () => {
  // 纯正弦的各个 kT 凹陷几乎一样深，不能因为数值误差落到 3T / 5T
  const picked = pickFromDips({ 23: 0.0002, 46: 0.0007, 69: 0.0015, 92: 0.0026 });
  assert(picked.ok, "应给出结果");
  assert(picked.tau === 23, `应选最短周期 23，实际 ${picked.tau}`);
});

test("兜底分支不输出贴着搜索下限的读数（旧版的 B1/C2）", () => {
  const analyzer = PC.createAnalyzer({ minFreq: 60, maxFreq: 1250, decimation: 2 });
  const tauMax = 400;
  // 单调下降、没有任何局部极小：与「窗内没有真实周期」时的退化情况一致，
  // 全局最小落在搜索下限（tauMax）附近。
  const dn = new Float32Array(tauMax + 2);
  for (let t = 0; t <= tauMax + 1; t++) dn[t] = 0.99 - t * 0.0001;
  const picked = analyzer._pickTau(dn, 8, tauMax);
  assert(!picked.ok, "落在搜索下限的退化解应判为无效");
});

test("整帧都不周期时判为无可信周期，不编造读数", () => {
  // 所有凹陷都 ≥0.4（气口 / 换字跨界）：不管选哪个 lag 都是乱数，
  // 应该判为无可信周期（rawF0 = 0），而不是输出 63 Hz 或某个高音。
  const picked = pickFromDips({ 90: 0.42, 181: 0.44, 272: 0.46 });
  assert(!picked.ok, "不可信的帧应判为无可信周期");
});

test("气口帧在 analyze() 里返回 rawF0 = 0", () => {
  // 白噪声帧的 aperiodicity 通常 > 0.4
  let seed = 20261119;
  const n = SAMPLE_RATE;
  const noise = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    noise[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.2;
  }
  const frames = analyzeSignal(noise);
  const fabricated = frames.filter((f) => f.rawF0 > 0 && f.aperiodicity > 0.45);
  assert(fabricated.length === 0,
    `不可信帧仍输出了 rawF0：${fabricated.length} 帧`);
});

test("周期倍增的合成信号被正确读成低八度", () => {
  // 相邻周期幅度交替（周期倍增）：真实周期是 2T，读数应是 f0/2
  const f0 = PC.midiToFreq(64, 440);
  const seconds = 1.6;
  const n = Math.round(SAMPLE_RATE * seconds);
  const signal = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const period = Math.floor(t * f0);
    const amp = period % 2 === 0 ? 1.35 : 0.65;
    signal[i] = 0.22 * amp * Math.sin(2 * Math.PI * f0 * t);
  }
  const frames = analyzeSignal(signal).filter((f) => f.valid);
  assert(frames.length > frames.length * 0.5, "有效帧过少");
  const med = median(frames.map((f) => f.f0));
  approx(med, f0 / 2, f0 * 0.01, "应读成低八度");
});

/* ================= 6. 逐帧状态机（读数保持） ================= */

console.log("\n[6] 状态机与读数保持");

function messageFor(f0, t, overrides) {
  return Object.assign({
    t,
    tEnd: t + 0.0427,
    f0,
    rawF0: f0,
    aperiodicity: 0.05,
    confidence: 0.95,
    db: -18,
    clipRatio: 0
  }, overrides || {});
}

test("单帧低置信度不清空曲线、读数保持", () => {
  const tracker = new PC.createTracker({ holdMs: 150 });
  const e4 = PC.midiToFreq(64, 440);
  let t = 0;
  for (let i = 0; i < 6; i++) tracker.track(messageFor(e4, (t += 0.021)));
  const before = tracker.current.label;

  const held = tracker.track(messageFor(e4, (t += 0.021), { aperiodicity: 0.9, confidence: 0.1 }));
  assert(held.status === "detecting", "单帧低置信度应保持检测中，实际 " + held.status);
  assert(held.held === true, "应标记为读数保持");
  assert(held.point === null, "保持期间不应新增曲线点");
  assert(tracker.current && tracker.current.label === before, "读数应保持");
});

test("低置信度持续超过 150 ms 才清空", () => {
  const tracker = new PC.createTracker({ holdMs: 150 });
  const e4 = PC.midiToFreq(64, 440);
  let t = 0;
  for (let i = 0; i < 6; i++) tracker.track(messageFor(e4, (t += 0.021)));
  for (let i = 0; i < 10; i++) {
    const out = tracker.track(messageFor(e4, (t += 0.021), { aperiodicity: 0.9, confidence: 0.1 }));
    if (!out.held) {
      assert(out.status === "low-confidence", "失持后状态应为 low-confidence");
      assert(out.current === null, "失持后读数应清空");
      return;
    }
  }
  throw new Error("低置信度 210 ms 后仍未清空读数");
});

test("2 帧的八度毛刺不会被写进曲线", () => {
  const tracker = new PC.createTracker();
  const g4 = PC.midiToFreq(67, 440);
  const g5 = PC.midiToFreq(79, 440);
  let t = 0;
  const points = [];
  for (let i = 0; i < 6; i++) points.push(tracker.track(messageFor(g4, (t += 0.021))).point);
  points.push(tracker.track(messageFor(g5, (t += 0.021))).point);
  points.push(tracker.track(messageFor(g5, (t += 0.021))).point);
  for (let i = 0; i < 4; i++) points.push(tracker.track(messageFor(g4, (t += 0.021))).point);

  const midis = points.filter(Boolean).map((p) => p.midi);
  assert(midis.every((m) => m < 67.5), "曲线上不应出现 G5：" + midis.map((m) => m.toFixed(1)).join(","));
});

test("真实的八度跳唱在 100 ms 内画出新音", () => {
  const tracker = new PC.createTracker();
  const g4 = PC.midiToFreq(67, 440);
  const g5 = PC.midiToFreq(79, 440);
  let t = 0;
  for (let i = 0; i < 6; i++) tracker.track(messageFor(g4, (t += 0.021)));
  const start = t;
  let reached = null;
  for (let i = 0; i < 8; i++) {
    const out = tracker.track(messageFor(g5, (t += 0.021)));
    if (out.current && out.current.midiFloat > 78.5 && reached === null) reached = t;
  }
  assert(reached !== null, "跳到 G5 后没有画出新音");
  assert((reached - start) * 1000 <= 100, `跟上耗时应 ≤100 ms，实际 ${((reached - start) * 1000).toFixed(0)} ms`);
});

test("设置变化后状态机按新音域判定", () => {
  const tracker = new PC.createTracker({ minMidi: 36, maxMidi: 84 });
  const c2 = PC.midiToFreq(36, 440);
  let t = 0;
  const inside = tracker.track(messageFor(c2, (t += 0.021)));
  assert(inside.status === "detecting", "C2 在 C2–C6 内应为检测中，实际 " + inside.status);
  approx(inside.current.midiFloat, 36, 0.3, "C2 音高");

  tracker.configure({ minMidi: 60, maxMidi: 72 });
  const out = tracker.track(messageFor(c2, (t += 0.021)));
  assert(out.status === "out-of-range", "音域收窄后 C2 应为超出范围，实际 " + out.status);
});

/* ================= 7. WAV 测试样例（可选） ================= */

console.log("\n[7] 测试音 WAV 回放验证");

const wavPath = path.join(__dirname, "fixtures", "a4.wav");
if (fs.existsSync(wavPath)) {
  test("fixtures/a4.wav 被识别为 A4", () => {
    const buffer = fs.readFileSync(wavPath);
    let offset = 12;
    let fmt = null;
    let data = null;
    while (offset + 8 <= buffer.length) {
      const id = buffer.toString("ascii", offset, offset + 4);
      const size = buffer.readUInt32LE(offset + 4);
      if (id === "fmt ") {
        fmt = {
          channels: buffer.readUInt16LE(offset + 10),
          sampleRate: buffer.readUInt32LE(offset + 12),
          bits: buffer.readUInt16LE(offset + 22)
        };
      } else if (id === "data") {
        data = buffer.subarray(offset + 8, offset + 8 + size);
      }
      offset += 8 + size + (size % 2);
    }
    assert(fmt && data, "WAV 结构不完整");
    assert(fmt.channels === 1 && fmt.bits === 16, "测试音应为 16-bit 单声道");
    const sampleCount = Math.floor(data.length / 2);
    const samples = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) samples[i] = data.readInt16LE(i * 2) / 32768;

    const analyzer = PC.createAnalyzer({ minFreq: 60, maxFreq: 1250, decimation: 2 });
    const results = [];
    for (let i = 0; i + WINDOW <= samples.length; i += HOP) {
      results.push(analyzer.analyze(samples.subarray(i, i + WINDOW), fmt.sampleRate));
    }
    const valid = results.filter((r) => r.valid);
    assert(valid.length > results.length * 0.5, "WAV 有效帧不足");
    const note = PC.freqToNote(median(valid.map((r) => r.f0)), 440);
    assert(note.label === "A4", "应识别为 A4，实际 " + note.label);
    assert(Math.abs(note.cents) < 3, "音分应接近 0");
  });
} else {
  console.log("  SKIP  fixtures/a4.wav 不存在（先运行 tools/make_test_tones.py）");
}

/* ================= 8. 现场录音回归（可选） ================= */

console.log("\n[8] 现场录音回归（docs/evidence/2026-11-18-mic-recording-48k-mono.wav）");

const recordingPath = path.join(__dirname, "..", "docs", "evidence", "2026-11-18-mic-recording-48k-mono.wav");
if (fs.existsSync(recordingPath)) {
  test("真实人声录音里没有倍数误锁帧", () => {
    // 与 tools/analyze-audio.js 使用同一套统计，避免两份实现漂移
    const harness = require("../tools/analyze-audio.js");
    const result = harness.analyze(recordingPath, {
      core: path.join(__dirname, "..", "app", "js", "pitch-core.js"),
      minFreq: 60,
      maxFreq: 1250
    });
    const stats = harness.summarize(result.PC, result.frames, { minFreq: 60, maxFreq: 1250 });
    const locks = stats.spikes.filter((s) => s.kind === "multiple");
    assert(locks.length === 0,
      "仍有倍数误锁帧：" + locks.map((s) => `t=${s.t.toFixed(3)}(Δ${s.delta.toFixed(1)})`).join(", "));
    assert(stats.validRatio > 0.45, `有效率过低：${(stats.validRatio * 100).toFixed(1)}%`);
    assert(stats.floorFrames === 0, `出现搜索下限读数 ${stats.floorFrames} 帧`);
  });
} else {
  console.log("  SKIP  现场录音 WAV 不存在（先按 docs/ISSUE_OCTAVE_JUMP.md §9.3 转码）");
}

/* ================= 汇总 ================= */

console.log("\n------------------------------------------------------------");
console.log(`结果：${passed} 通过，${failed} 失败`);
if (NOTES.length) {
  console.log("\n各音实测误差（中位）：");
  console.log("  音名   目标 Hz     实测 Hz     误差 cents");
  NOTES.forEach((item) => {
    const a = noteAccuracy[item.label];
    if (!a) return;
    console.log(
      "  " + item.label.padEnd(6) +
      a.freq.toFixed(3).padStart(9) +
      a.med.toFixed(3).padStart(13) +
      a.errCents.toFixed(2).padStart(12)
    );
  });
}
console.log("");

if (failed > 0) {
  console.log("失败用例：");
  failures.forEach((f) => console.log("  - " + f.name + "：" + f.message));
  process.exit(1);
}
process.exit(0);
