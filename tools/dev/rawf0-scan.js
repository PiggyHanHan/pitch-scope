#!/usr/bin/env node
/*!
 * rawf0-scan.js — 按 rawF0 口径扫「向上」的八度族错误帧
 *
 * 背景：`f0` 在越界时被置 0，而 `rawF0` 保留算法原始输出；
 * 只看 f0 / valid 的统计会把越界的高八度误判整批抹掉
 * （见 docs/ISSUE_OCTAVE_JUMP_CORRECTION.md §7）。
 *
 * 这个脚本只做一件事：按 8 种帧起点偏移（每次 +128 样本）统计 rawF0 高过阈值的帧数，
 * 并按 aperiodicity 分档，用来对比两个版本的 pitch-core。
 *
 * 用法：
 *   node tools/dev/rawf0-scan.js <wav> [--core app/js/pitch-core.js]
 *        [--min-freq 64.1] [--max-freq 1067.4] [--offsets 8]
 */
"use strict";

const path = require("path");
const harness = require("../analyze-audio.js");
const PC = require("../../app/js/pitch-core.js");

function parseArgs(argv) {
  const out = {
    file: null,
    core: "app/js/pitch-core.js",
    minFreq: PC.midiToFreq(36, 440) * 0.98,
    maxFreq: PC.midiToFreq(84, 440) * 1.02,
    offsets: 8
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--core") out.core = argv[++i];
    else if (a === "--min-freq") out.minFreq = Number(argv[++i]);
    else if (a === "--max-freq") out.maxFreq = Number(argv[++i]);
    else if (a === "--offsets") out.offsets = Number(argv[++i]);
    else out.file = out.file || a;
  }
  return out;
}

function scan(options) {
  const rows = [];
  const all = [];
  for (let k = 0; k < options.offsets; k++) {
    const result = harness.analyze(options.file, {
      core: options.core,
      minFreq: options.minFreq,
      maxFreq: options.maxFreq,
      offset: k * 128
    });
    const core = result.PC;
    const rowsK = { offset: k * 128, total: 0, above: 0, strict: 0, bands: [0, 0, 0] };
    result.frames.forEach((f) => {
      rowsK.total++;
      const r = f.rawF0;
      if (!(r > 0)) return;
      const midi = core.freqToMidi(r, 440);
      if (midi <= 72.35) return; // C5 以上
      rowsK.above++;
      const aper = f.aperiodicity;
      if (aper <= 0.25) rowsK.bands[0]++;
      else if (aper <= 0.5) rowsK.bands[1]++;
      else rowsK.bands[2]++;
      if (aper <= 0.25) rowsK.strict++;
      all.push({ offset: k * 128, t: f.t, midi, aper });
    });
    rows.push(rowsK);
  }
  return { rows, all };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.file) {
    console.log("用法: node tools/dev/rawf0-scan.js <wav> [--core 路径] [--offsets 8]");
    process.exit(1);
  }
  const { rows, all } = scan(options);
  console.log(`文件 ${options.file}`);
  console.log(`算法 ${options.core} · 搜索范围 ${options.minFreq.toFixed(1)}–${options.maxFreq.toFixed(1)} Hz`);
  console.log("rawF0 落到 C5 以上（midi > 72.35）的帧数：\n");
  console.log("偏移(样本)  总帧   合计  aper≤0.25  0.25–0.5  >0.5");
  rows.forEach((r) => {
    console.log(
      String(r.offset).padStart(8) +
      String(r.total).padStart(7) +
      String(r.above).padStart(7) +
      String(r.bands[0]).padStart(11) +
      String(r.bands[1]).padStart(10) +
      String(r.bands[2]).padStart(6)
    );
  });
  const sum = rows.reduce((acc, r) => acc + r.above, 0);
  const strict = rows.reduce((acc, r) => acc + r.bands[0], 0);
  console.log(`\n合计 ${sum} 帧（8 种对齐），其中能过 0.25 置信度门限的 ${strict} 帧`);
  const worst = all.slice().sort((a, b) => a.aper - b.aper).slice(0, 5);
  if (worst.length) {
    console.log("aperiodicity 最低的 5 帧：");
    worst.forEach((w) => console.log(`  t=${w.t.toFixed(3)}s midi=${w.midi.toFixed(1)} aper=${w.aper.toFixed(3)}`));
  }
}

if (require.main === module) {
  try { main(); } catch (err) { console.error("扫描失败：" + err.message); process.exit(1); }
}

module.exports = { scan };
