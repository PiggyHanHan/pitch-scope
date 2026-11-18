#!/usr/bin/env node
/*!
 * diag-yin.js — 打开 YIN 的中间量，看某个时刻的 d'(τ) 局部极小分布
 *
 * 用途：判断一次八度族跳变到底是「真周期凹陷变浅被跳过」还是「兜底分支」。
 *
 * 用法：
 *   node tools/dev/diag-yin.js <wav> <t1,t2,...> [--core 路径] [--around 0.15]
 */
"use strict";

const path = require("path");
const analyzeAudio = require("../analyze-audio.js");

function parseArgs(argv) {
  const out = { file: null, times: [], core: "app/js/pitch-core.js", around: 0.12 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--core") out.core = argv[++i];
    else if (argv[i] === "--around") out.around = Number(argv[++i]);
    else rest.push(argv[i]);
  }
  out.file = rest[0];
  out.times = (rest[1] || "").split(",").filter(Boolean).map(Number);
  return out;
}

function localMinima(dn, tauMin, tauMax) {
  const minima = [];
  for (let tau = Math.max(1, tauMin); tau <= tauMax - 1; tau++) {
    if (dn[tau] <= dn[tau - 1] && dn[tau] <= dn[tau + 1]) {
      minima.push({ tau, value: dn[tau] });
    }
  }
  return minima.sort((a, b) => a.value - b.value);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.log("用法: node tools/dev/diag-yin.js <wav> <t1,t2,...> [--core 路径] [--around 秒]");
    process.exit(1);
  }

  const wav = analyzeAudio.readWav(args.file);
  const corePath = path.isAbsolute(args.core) ? args.core : path.resolve(__dirname, "../..", args.core);
  const PC = require(corePath);
  const WINDOW = 4096;
  const HOP = 1024;
  const analyzer = PC.createAnalyzer({ minFreq: 60, maxFreq: 1250, decimation: 2 });
  const dsr = wav.sampleRate / analyzer.decimation;

  args.times.forEach(function (time) {
    const center = Math.round((time * wav.sampleRate) / HOP) * HOP;
    const span = Math.max(1, Math.round(args.around * wav.sampleRate / HOP));

    console.log("\n================ t ≈ " + time.toFixed(3) + " s ================");
    for (let k = -span; k <= span; k++) {
      const offset = center + k * HOP;
      if (offset < 0 || offset + WINDOW > wav.samples.length) continue;
      const res = analyzer.analyze(wav.samples.subarray(offset, offset + WINDOW), wav.sampleRate);
      const dn = analyzer._dn;
      const tauMax = Math.min(Math.floor(WINDOW / analyzer.decimation / 2) - 2,
        Math.ceil(dsr / analyzer.minFreq) + 1);
      const tauMin = Math.max(2, Math.floor(dsr / (analyzer.maxFreq * 1.5)) - 1);
      const minima = localMinima(dn, tauMin, tauMax).slice(0, 6);

      console.log("\n  t=" + (offset / wav.sampleRate).toFixed(3) +
        "  f0=" + (res.f0 ? res.f0.toFixed(2) : "0") +
        "  raw=" + res.rawF0.toFixed(2) +
        "  aper=" + res.aperiodicity.toFixed(3) +
        "  db=" + res.db.toFixed(1) +
        "  valid=" + res.valid);
      minima.forEach(function (m) {
        console.log("     τ=" + String(m.tau).padStart(4) +
          "  f=" + (dsr / m.tau).toFixed(1).padStart(7) + " Hz" +
          "  d'=" + m.value.toFixed(3) +
          (m.value < 0.15 ? "  ← 低于阈值" : ""));
      });
    }
  });
}

main();
