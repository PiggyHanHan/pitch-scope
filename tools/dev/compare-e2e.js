"use strict";
/*
 * compare-e2e.js — 对比两份 e2e-check.js 导出的浏览器逐帧日志，并与 Node 侧复算结果对照
 *
 * 指标口径（与页面显示一致）：只统计 f0>0 且 aperiodicity ≤ 0.25（置信度门限 75%）的帧，
 * 相邻点间隔 >0.22 s 视为断段，同一段内比较。
 */
const fs = require("fs");
const path = require("path");
const harness = require("../analyze-audio.js");
const PC = require("../../app/js/pitch-core.js");

const ROOT = path.resolve(__dirname, "..", "..");
const CONFIDENCE = 0.75;                 // 页面默认置信度门限
const APER_GATE = 1 - CONFIDENCE;        // 0.25
const MIN_FREQ = PC.midiToFreq(36, 440) * 0.98;
const MAX_FREQ = PC.midiToFreq(84, 440) * 1.02;
const WAV = path.join(ROOT, "docs/evidence/2026-11-18-mic-recording-48k-mono.wav");

function pointsOf(frames) {
  const points = frames
    .filter((f) => f.f0 > 0 && f.aperiodicity <= APER_GATE)
    .map((f) => ({ t: f.t, midi: PC.freqToMidi(f.f0, 440) }));
  const t0 = points.length ? points[0].t : 0;
  return points.map((p) => ({ t: p.t - t0, midi: p.midi }));
}

function report(label, file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const points = pointsOf(data.frames);
  const stats = harness.summarizePoints(points, PC);
  console.log("\n== " + label + " ==");
  console.log("页面 " + data.url + " · 状态栏「" + data.pageStatus + "」· 页面异常 " +
    ((data.exceptions || []).length) + " 条 · 浏览器帧 " + data.frames.length);
  console.log(`曲线点 ${points.length} · 断段 ${stats.segments} · 八度族跳变 ${stats.spikes.length} 帧 · 大跳变 ${stats.bigJumps.length} 帧`);
  stats.spikes.forEach((s) => {
    console.log(`  t=${s.t.toFixed(3)}s Δ=${s.delta.toFixed(1)} 半音 midi=${s.midi.toFixed(2)} 局部=${s.base.toFixed(2)}`);
  });
  return { data, points, stats };
}

const before = report("修复前（浏览器，12b8bd7）", path.join(ROOT, ".tmp/e2e-baseline.json"));
const after = report("修复后（浏览器）", path.join(ROOT, ".tmp/e2e-new.json"));

/* Node 侧复算：同一段 WAV、同样搜索范围、同样门限 */
const analysis = harness.analyze(WAV, { core: path.join(ROOT, "app/js/pitch-core.js"), minFreq: MIN_FREQ, maxFreq: MAX_FREQ });
const nodeFrames = analysis.frames.map((f) => ({ t: f.t, f0: f.f0, aperiodicity: f.aperiodicity, valid: f.valid }));
const nodePoints = pointsOf(nodeFrames);
const nodeStats = harness.summarizePoints(nodePoints, PC);
console.log(`\n== Node 侧复算（${MIN_FREQ.toFixed(1)}–${MAX_FREQ.toFixed(1)} Hz，aper ≤ ${APER_GATE}）==`);
console.log(`帧 ${nodeFrames.length} · 曲线点 ${nodePoints.length} · 断段 ${nodeStats.segments} · 八度族跳变 ${nodeStats.spikes.length} 帧`);
nodeStats.spikes.forEach((s) => {
  console.log(`  t=${s.t.toFixed(3)}s Δ=${s.delta.toFixed(1)} 半音 midi=${s.midi.toFixed(2)} 局部=${s.base.toFixed(2)}`);
});

/* 浏览器（修复后）与 Node 复算逐帧对照：搜一个整体时间偏移后比音分差 */
const browserFrames = after.data.frames
  .filter((f) => f.f0 > 0 && f.aperiodicity <= APER_GATE)
  .map((f) => ({ t: f.t - after.data.frames[0].t, f0: f.f0 }));
const reference = analysis.frames
  .filter((f) => f.valid && f.f0 > 0)
  .map((f) => ({ t: f.t, f0: f.f0 }));

let matched = { offset: 0, count: 0, maxCents: Infinity, meanCents: Infinity };
for (let offset = 0; offset <= 0.32; offset += 1024 / 48000) {
  let count = 0;
  let maxCents = 0;
  let sum = 0;
  browserFrames.forEach((bf) => {
    let nearest = null;
    let bestDist = Infinity;
    reference.forEach((rf) => {
      const dist = Math.abs(rf.t - (bf.t + offset));
      if (dist < bestDist) { bestDist = dist; nearest = rf; }
    });
    if (!nearest || bestDist > 0.002) return;
    const cents = Math.abs(PC.centsBetween(bf.f0, nearest.f0));
    count++;
    sum += cents;
    if (cents > maxCents) maxCents = cents;
  });
  const meanCents = count ? sum / count : Infinity;
  if (count > matched.count || (count === matched.count && meanCents < matched.meanCents)) {
    matched = { offset, count, maxCents, meanCents };
  }
}

console.log("\n== 浏览器（修复后）vs Node 复算逐帧对照 ==");
console.log(`最优时间偏移 ${(matched.offset * 1000).toFixed(1)} ms · 对齐 ${matched.count}/${browserFrames.length} 帧 · ` +
  `平均音分差 ${matched.meanCents.toFixed(2)} · 最大 ${matched.maxCents.toFixed(2)}`);

const summary = {
  before: { frames: before.data.frames.length, points: before.points.length, segments: before.stats.segments, spikes: before.stats.spikes.length },
  after: { frames: after.data.frames.length, points: after.points.length, segments: after.stats.segments, spikes: after.stats.spikes.length },
  node: { frames: nodeFrames.length, points: nodePoints.length, segments: nodeStats.segments, spikes: nodeStats.spikes.length },
  match: matched
};
fs.writeFileSync(path.join(ROOT, ".tmp/e2e-summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log("\n汇总已写入 .tmp/e2e-summary.json");
