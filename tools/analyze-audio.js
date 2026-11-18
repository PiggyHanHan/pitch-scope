#!/usr/bin/env node
/*!
 * analyze-audio.js — 用项目自己的算法逐帧复算一段音频（问题排查 / 改动前后对比）
 *
 * 用法：
 *   node tools/analyze-audio.js <audio.wav> [--core <path-to-pitch-core.js>]
 *                               [--csv <out.csv>] [--min-freq 60] [--max-freq 1250]
 *                               [--label "基线"]
 *
 * 只读 16-bit / 32-bit-float 单声道或立体声 WAV（用 ffmpeg 或
 * tools/dev/decode-m4a.html 先把素材转成 48 kHz 单声道 WAV）。
 *
 * 输出指标（对应 docs/ISSUE_OCTAVE_JUMP.md 的验收标准）：
 *   - 有效帧数 / 有效率
 *   - 八度族尖峰帧数：与局部中位（±8 帧）相差 ≥8.5 半音、且偏差落在 12 的倍数 ±3 半音内
 *   - 大跳变帧数：与局部中位相差 ≥5 半音（不限方向）
 *   - 曲线断段数：相邻有效帧时间差 > 0.22 s 计为断段（与 Canvas 绘制规则一致）
 *   - 搜索下限读数帧数：f0 贴着 minFreq 的帧（旧版兜底分支会输出固定的 63.49 Hz）
 */
"use strict";

const fs = require("fs");
const path = require("path");

const WINDOW = 4096;
const HOP = 1024;

function parseArgs(argv) {
  const out = {
    file: null,
    core: "app/js/pitch-core.js",
    csv: null,
    label: "",
    minFreq: 60,
    maxFreq: 1250,
    tracker: "off",
    trackerCore: "app/js/pitch-core.js",
    a4: 440,
    gateDb: -60,
    confidence: 0.75,
    minMidi: 36,
    maxMidi: 84
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--core") out.core = argv[++i];
    else if (a === "--csv") out.csv = argv[++i];
    else if (a === "--label") out.label = argv[++i];
    else if (a === "--min-freq") out.minFreq = Number(argv[++i]);
    else if (a === "--max-freq") out.maxFreq = Number(argv[++i]);
    else if (a === "--tracker") out.tracker = argv[++i];
    else if (a === "--tracker-core") out.trackerCore = argv[++i];
    else if (a === "--a4") out.a4 = Number(argv[++i]);
    else if (a === "--gate-db") out.gateDb = Number(argv[++i]);
    else if (a === "--confidence") out.confidence = Number(argv[++i]);
    else if (a === "--min-midi") out.minMidi = Number(argv[++i]);
    else if (a === "--max-midi") out.maxMidi = Number(argv[++i]);
    else if (a === "--help" || a === "-h") out.help = true;
    else positional.push(a);
  }
  out.file = positional[0] || null;
  return out;
}

/** 读取 8/16/24/32-bit PCM 或 32/64-bit float 的 WAV，返回 {samples, sampleRate}。 */
function readWav(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("不是 WAV 文件：" + file);
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      fmt = {
        format: buffer.readUInt16LE(offset + 8),
        channels: buffer.readUInt16LE(offset + 10),
        sampleRate: buffer.readUInt32LE(offset + 12),
        bits: buffer.readUInt16LE(offset + 22)
      };
    } else if (id === "data") {
      data = buffer.subarray(offset + 8, offset + 8 + size);
    }
    offset += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("WAV 结构不完整：" + file);

  const frameBytes = fmt.bits / 8;
  const frames = Math.floor(data.length / (frameBytes * fmt.channels));
  const samples = new Float32Array(frames);
  const float = fmt.format === 3;

  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const at = (i * fmt.channels + c) * frameBytes;
      let v;
      if (float) v = fmt.bits === 64 ? data.readDoubleLE(at) : data.readFloatLE(at);
      else if (fmt.bits === 8) v = data.readUInt8(at) / 128 - 1;
      else if (fmt.bits === 16) v = data.readInt16LE(at) / 32768;
      else if (fmt.bits === 24) v = data.readIntLE(at, 3) / 8388608;
      else if (fmt.bits === 32) v = data.readInt32LE(at) / 2147483648;
      else throw new Error("不支持的位深：" + fmt.bits);
      acc += v / fmt.channels;
    }
    samples[i] = acc;
  }
  return { samples, sampleRate: fmt.sampleRate, channels: fmt.channels, bits: fmt.bits };
}

function median(values) {
  if (!values.length) return NaN;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, p) {
  if (!values.length) return NaN;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

function analyze(file, options) {
  const corePath = path.isAbsolute(options.core)
    ? options.core
    : path.resolve(__dirname, "..", options.core);
  const PC = require(corePath);
  const wav = readWav(file);
  const analyzer = PC.createAnalyzer({
    minFreq: options.minFreq,
    maxFreq: options.maxFreq,
    decimation: 2
  });
  const dsr = wav.sampleRate / analyzer.decimation;
  const tauMin = Math.max(2, Math.floor(dsr / (options.maxFreq * 1.5)) - 1);
  const tauMax = Math.min(
    Math.floor(WINDOW / analyzer.decimation / 2) - 2,
    Math.ceil(dsr / options.minFreq) + 1
  );

  const frames = [];
  const messages = [];
  const start = Math.max(0, Math.round(options.offset || 0));
  for (let offset = start; offset + WINDOW <= wav.samples.length; offset += HOP) {
    const window = wav.samples.subarray(offset, offset + WINDOW);
    const res = analyzer.analyze(window, wav.sampleRate);

    // 保留 d'(τ) 的局部极小，后面用来判断一次跳变是不是「倍数误锁」
    let minima = null;
    if (res.valid && analyzer._dn) {
      const dn = analyzer._dn;
      minima = [];
      for (let t = tauMin; t <= tauMax - 1; t++) {
        if (dn[t] <= dn[t - 1] && dn[t] <= dn[t + 1]) minima.push({ tau: t, value: dn[t] });
      }
    }

    frames.push({
      t: offset / wav.sampleRate,
      f0: res.f0,
      rawF0: res.rawF0,
      aperiodicity: res.aperiodicity,
      confidence: res.confidence,
      db: res.db,
      valid: res.valid,
      minima,
      decimatedRate: dsr
    });

    // 与 pitch-worklet.js 发给主线程的消息保持一致
    let clip = 0;
    for (let i = 0; i < window.length; i++) {
      if (window[i] > 0.98 || window[i] < -0.98) clip++;
    }
    const windowSec = WINDOW / wav.sampleRate;
    const endTime = (offset + WINDOW) / wav.sampleRate;
    messages.push({
      t: endTime - windowSec / 2,
      tEnd: endTime,
      f0: res.f0,
      rawF0: res.rawF0,
      aperiodicity: res.aperiodicity,
      confidence: res.confidence,
      db: res.db,
      clipRatio: clip / WINDOW
    });
  }
  return { PC, wav, frames, messages, tauMin, tauMax };
}

/**
 * 判断一帧的跳变是否属于「倍数误锁」：
 * 选中的 τ 是某个更短周期 τ/k 的倍数，而 τ/k 处同样存在一个深度与它相差
 * 不超过 slack 的局部极小 —— 这正是 d'(T) 变浅、d'(2T) 更深时旧规则会踩的坑。
 */
function classifyFrame(frame, slack) {
  if (!frame || !frame.minima || !(frame.rawF0 > 0)) return "unknown";
  const picked = frame.decimatedRate / frame.rawF0;
  const minima = frame.minima;

  let nearest = null;
  let nearestDist = Infinity;
  for (const m of minima) {
    const dist = Math.abs(m.tau - picked);
    if (dist < nearestDist) { nearest = m; nearestDist = dist; }
  }
  if (!nearest || nearestDist > 2) return "unknown";

  for (let k = 2; k <= 4; k++) {
    const target = picked / k;
    if (target < 8) continue;
    const span = Math.max(1, Math.round(target * 0.04));
    for (const m of minima) {
      if (m.tau >= picked) continue;
      if (Math.abs(m.tau - target) > span) continue;
      if (m.value <= nearest.value + slack) return "multiple";
    }
  }
  return "step";
}

/* 旧版状态机：任一帧不进入 detecting 就 reset 平滑器、读数清零，且所有跳变只要 2 帧。 */
const TRACKER_PRESETS = {
  old: {
    smoothing: { medianSize: 3, tauMs: 30, jumpConfirm: 2, octaveConfirm: 2 },
    holdMs: 0
  },
  new: {
    smoothing: { medianSize: 3, tauMs: 30 },
    holdMs: 150
  }
};

function runTracker(PC, messages, options) {
  if (typeof PC.createTracker !== "function") return null;
  const preset = TRACKER_PRESETS[options.tracker];
  if (!preset) return null;
  const tracker = PC.createTracker(Object.assign({
    a4: options.a4,
    gateDb: options.gateDb,
    confidence: options.confidence,
    minMidi: options.minMidi,
    maxMidi: options.maxMidi
  }, preset));

  const points = [];
  let held = 0;
  let blanks = 0;
  let blankMs = 0;
  let lastStatus = null;
  let blankSince = null;

  messages.forEach(function (msg) {
    const out = tracker.track(msg);
    if (out.point) points.push(out.point);
    if (out.held) held++;
    if (out.status === "detecting") {
      if (blankSince !== null) {
        blankMs += (msg.t - blankSince) * 1000;
        blankSince = null;
      }
    } else if (lastStatus === "detecting" || blankSince === null) {
      blanks++;
      if (blankSince === null) blankSince = msg.t;
    }
    lastStatus = out.status;
  });

  return { points, held, blanks, blankMs };
}

function summarizeCurve(points, PC) {
  return summarizePoints(points.map((p) => ({ t: p.t, midi: p.midi })), PC);
}

/**
 * 八度族跳变统计。
 *
 * 判据很直白：每个点都跟「同一段内、前后各 8 个点」的中位音高比，
 * 偏差 ≥8.5 半音、且落在 12 的倍数 ±3 半音内，就算一次八度族跳变。
 * 同一段 = 相邻点间隔 ≤0.22 s（与 Canvas 连线规则一致），跨气口不比较。
 *
 * 每个跳变再用该帧自己的 d'(τ) 归类（见 classifyFrame）：
 *   - multiple：选中的 τ 是更短周期 τ/k 的倍数，且 τ/k 处的凹陷深度与它相差
 *     不超过 SLACK —— 典型的「倍数误锁」，也就是本次要修的问题；
 *   - step：附近没有可比凹陷，说明是换音 / 气口底噪这类台阶，不是选峰错误。
 */
function summarizePoints(points, PC) {
  const halfWindow = 8;
  const segOf = new Array(points.length);
  let segments = points.length ? 1 : 0;
  segOf[0] = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].t - points[i - 1].t > 0.22) segments++;
    segOf[i] = segments - 1;
  }

  const spikes = [];
  const bigJumps = [];
  for (let i = 0; i < points.length; i++) {
    const midi = points[i].midi;
    const neighbours = [];
    for (let k = i - halfWindow; k <= i + halfWindow; k++) {
      if (k === i || k < 0 || k >= points.length) continue;
      if (segOf[k] !== segOf[i]) continue;
      neighbours.push(points[k].midi);
    }
    if (neighbours.length < 8) continue;

    const base = median(neighbours);
    const delta = midi - base;
    if (Math.abs(delta) < 5) continue;
    bigJumps.push({ t: points[i].t, delta, midi, base });

    const octaveOffset = Math.abs(delta) - 12 * Math.round(Math.abs(delta) / 12);
    if (Math.abs(delta) >= 8.5 && Math.abs(octaveOffset) <= 3) {
      spikes.push({ t: points[i].t, delta, midi, base, index: i });
    }
  }
  return { points: points.length, spikes, bigJumps, segments };
}

const OCTAVE_SLACK = 0.10;

function summarize(PC, frames, options) {
  const valid = frames.filter((f) => f.valid && f.f0 > 0);
  const midis = valid.map((f) => PC.freqToMidi(f.f0, 440));

  const shape = valid.map((f) => ({ t: f.t, midi: PC.freqToMidi(f.f0, 440) }));
  const curve = summarizePoints(shape, PC);

  const spikes = curve.spikes.map((s) => {
    const frame = valid[s.index];
    return {
      t: s.t,
      delta: s.delta,
      f0: frame ? frame.f0 : 0,
      base: s.base,
      aperiodicity: frame ? frame.aperiodicity : 1,
      kind: classifyFrame(frame, OCTAVE_SLACK)
    };
  });

  // 搜索下限读数：f0 贴着 minFreq（旧版兜底会把 tau 推到 tauMax）
  const floorFreq = options.minFreq;
  const floorFrames = valid.filter((f) => f.f0 <= floorFreq * 1.03).length;

  return {
    frames: frames.length,
    valid: valid.length,
    validRatio: frames.length ? valid.length / frames.length : 0,
    medianMidi: median(midis),
    medianFreq: valid.length ? median(valid.map((f) => f.f0)) : NaN,
    p95CentsSpread: valid.length
      ? (percentile(midis, 0.95) - percentile(midis, 0.05)) * 100
      : NaN,
    spikes,
    bigJumps: curve.bigJumps,
    segments: curve.segments,
    floorFrames,
    lockSpikes: spikes.filter((s) => s.kind === "multiple").length,
    stepSpikes: spikes.filter((s) => s.kind === "step").length
  };
}

function formatSummary(label, stats) {
  const lines = [];
  lines.push("== " + (label || "分析") + " ==");
  lines.push(`帧数 ${stats.frames} · 有效 ${stats.valid}（${(stats.validRatio * 100).toFixed(1)}%）`);
  lines.push(`中位音高 ${stats.medianMidi.toFixed(2)}（${stats.medianFreq.toFixed(1)} Hz）· P5–P95 跨度 ${stats.p95CentsSpread.toFixed(0)} cents`);
  lines.push(`八度族跳变 ${stats.spikes.length} 帧（倍数误锁 ${stats.lockSpikes} · 换音台阶 ${stats.stepSpikes}）` +
    ` · 大跳变（≥5 半音）${stats.bigJumps.length} 帧 · 曲线断段 ${stats.segments}`);
  lines.push(`搜索下限读数帧 ${stats.floorFrames}`);
  return lines.join("\n");
}

function csvOf(frames) {
  const rows = ["t,f0,rawF0,aperiodicity,confidence,db,valid"];
  frames.forEach((f) => {
    rows.push([
      f.t.toFixed(3),
      f.f0.toFixed(4),
      f.rawF0.toFixed(4),
      f.aperiodicity.toFixed(4),
      f.confidence.toFixed(4),
      f.db.toFixed(2),
      f.valid ? 1 : 0
    ].join(","));
  });
  return rows.join("\n") + "\n";
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.file) {
    console.log("用法: node tools/analyze-audio.js <audio.wav> [--core <path>] [--csv <out.csv>] [--label 名称]" +
      " [--tracker old|new] [--gate-db -60] [--confidence 0.75] [--min-midi 36] [--max-midi 84] [--a4 440]");
    process.exit(args.file ? 0 : 1);
  }

  const { PC, wav, frames, messages } = analyze(args.file, args);
  const stats = summarize(PC, frames, args);

  console.log(`文件 ${args.file} · ${(wav.samples.length / wav.sampleRate).toFixed(2)} s · ${wav.sampleRate} Hz · ${wav.channels} 声道 · ${wav.bits}-bit`);
  console.log(`算法 ${args.core} · 窗口 ${WINDOW} / 跳帧 ${HOP} · 搜索范围 ${args.minFreq}–${args.maxFreq} Hz`);
  console.log("");
  console.log(formatSummary(args.label || path.basename(args.file), stats));

  if (stats.spikes.length) {
    console.log("\n八度族跳变明细：");
    stats.spikes.forEach((s) => {
      const kind = s.kind === "multiple" ? "倍数误锁" : s.kind === "step" ? "换音台阶" : "无法判定";
      console.log(`  t=${s.t.toFixed(3)}s Δ=${s.delta.toFixed(1)} 半音 f0=${s.f0.toFixed(1)}Hz 局部=${s.base.toFixed(2)} aper=${s.aperiodicity.toFixed(3)} · ${kind}`);
    });
  }

  let tracker = null;
  if (args.tracker !== "off") {
    const TrackerPC = require(path.isAbsolute(args.trackerCore)
      ? args.trackerCore
      : path.resolve(__dirname, "..", args.trackerCore));
    tracker = runTracker(TrackerPC, messages, args);
    if (!tracker) {
      console.log("\n（--tracker 需要核心模块提供 createTracker）");
    } else {
      const curve = summarizeCurve(tracker.points, PC);
      console.log("\n-- 曲线级（经过状态机 / 平滑，即页面上真正画出来的部分）· 预设 " + args.tracker + " --");
      console.log(`曲线点 ${curve.points} · 八度族跳变 ${curve.spikes.length} · 大跳变（≥5 半音）${curve.bigJumps.length} · 断段 ${curve.segments}`);
      console.log(`读数保持帧 ${tracker.held} · 非检测状态切换 ${tracker.blanks} 次，累计 ${tracker.blankMs.toFixed(0)} ms`);
      curve.spikes.forEach((s) => {
        console.log(`  跳变 t=${s.t.toFixed(3)}s Δ=${s.delta.toFixed(1)} 半音 midi=${s.midi.toFixed(2)} 局部=${s.base.toFixed(2)}`);
      });
    }
  }

  if (args.csv) {
    fs.writeFileSync(args.csv, csvOf(frames), "utf8");
    console.log("\nCSV 已写入 " + args.csv);
  }
  return { stats, tracker };
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error("分析失败：" + err.message);
    process.exit(1);
  }
}

module.exports = { readWav, analyze, summarize, summarizePoints, classifyFrame, formatSummary, csvOf, median, percentile, TRACKER_PRESETS, runTracker };
