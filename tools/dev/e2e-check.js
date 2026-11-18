#!/usr/bin/env node
/*!
 * e2e-check.js — 在真实浏览器里跑一遍页面音频链路，把逐帧结果落盘
 *
 * 做法：
 *   1. 用无头 Chrome 打开页面；
 *   2. 页面加载后注入一小段脚本：
 *      - 解码指定 WAV，用 AudioBufferSourceNode → MediaStreamDestination 造一个
 *        「虚拟麦克风」，并顶掉 navigator.mediaDevices.getUserMedia
 *        （Chrome 自带的 --use-file-for-fake-audio-capture 在无头模式下会出静音）；
 *      - 包住 AudioWorkletNode 的 port.onmessage，记录 worklet 发出的每一帧
 *        { f0, rawF0, aperiodicity, db, t }；
 *   3. 点「开始检测」，等 N 秒，把记录导出成 JSON。
 *
 * 用法：
 *   node tools/dev/e2e-check.js --url http://127.0.0.1:8199/app/pitch-scope.html \
 *        --wav-url /docs/evidence/2026-11-18-mic-recording-48k-mono.wav \
 *        --out .tmp/e2e-new.json --label 修复后 --seconds 24
 *
 * 只用于本地验证，不参与页面运行。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
];

function parseArgs(argv) {
  const out = {
    url: "http://127.0.0.1:8199/app/pitch-scope.html",
    wavUrl: "/docs/evidence/2026-11-18-mic-recording-48k-mono.wav",
    out: ".tmp/e2e.json",
    label: "e2e",
    seconds: 24,
    port: 9333,
    shot: null,
    keepOpen: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") out.url = argv[++i];
    else if (a === "--wav-url") out.wavUrl = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--label") out.label = argv[++i];
    else if (a === "--seconds") out.seconds = Number(argv[++i]);
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--shot") out.shot = argv[++i];
    else if (a === "--keep-open") out.keepOpen = true;
  }
  return out;
}

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("没有找到 Chrome / Edge");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function httpJson(url, method) {
  const res = await fetch(url, { method: method || "GET" });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

async function waitForDevtools(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await httpJson(`http://127.0.0.1:${port}/json/version`);
    } catch (err) {
      await sleep(200);
    }
  }
  throw new Error("Chrome DevTools 端口没有起来");
}

/** 极简 CDP 客户端：够用就好，不引第三方依赖。 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      this.events.push(msg);
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    });
    if (result.exceptionDetails) {
      throw new Error("页面内异常：" + (result.exceptionDetails.text || "") +
        " " + ((result.exceptionDetails.exception && result.exceptionDetails.exception.description) || ""));
    }
    return result.result.value;
  }

  close() {
    try { this.ws.close(); } catch (err) { /* noop */ }
  }
}

/**
 * 注入脚本：
 *   - __installVirtualMic(url)：解码 WAV，并把 AudioContext.createMediaStreamSource
 *     换成「直接播放这段 buffer 的 source 节点」。无头 Chrome 里
 *     MediaStreamDestination / fake audio capture 都会出静音，所以只能在
 *     createMediaStreamSource 这一层替换；页面本身（worklet、状态机、Canvas）不变。
 *   - 包装 AudioWorkletNode：记录 pitch 消息；
 *   - __pitchProbe()：确认音频时钟在走、当前 buffer 位置。
 */
const INJECT = `
(function () {
  if (window.__pitchLogInstalled) return "already";
  window.__pitchLogInstalled = true;
  window.__pitchLog = [];
  window.__pitchErrors = [];
  window.__pitchNodes = 0;
  window.__pitchCtxs = [];
  window.__pitchPorts = [];

  window.__installVirtualMic = function (url) {
    if (window.__micPromise) return window.__micPromise;
    window.__micPromise = (async function () {
      var res = await fetch(url);
      if (!res.ok) throw new Error("WAV 拉取失败 " + res.status);
      var raw = await res.arrayBuffer();
      var decoder = new OfflineAudioContext(1, 1, 48000);
      var audio = await decoder.decodeAudioData(raw);
      window.__virtualAudio = audio;
      window.__micInfo = {
        seconds: audio.duration,
        sampleRate: audio.sampleRate,
        channels: audio.numberOfChannels
      };

      var Ctx = window.AudioContext || window.webkitAudioContext;
      var proto = Ctx.prototype;
      var orig = proto.createMediaStreamSource;
      proto.createMediaStreamSource = function (stream) {
        var buffer = window.__virtualAudio;
        if (!buffer) return orig.call(this, stream);
        var self = this;
        var node = this.createBufferSource();
        node.buffer = buffer;
        node.loop = true;
        node.start();
        window.__virtualSrc = node;
        return {
          connect: function (target) { node.connect(target); return target; },
          disconnect: function () { try { node.disconnect(); } catch (err) { /* noop */ } }
        };
      };
      return window.__micInfo;
    })();
    return window.__micPromise;
  };

  window.__pitchProbe = async function () {
    var ctx = window.__pitchCtxs[0];
    var node = window.__virtualSrc;
    var an = window.__probeAnalyser;
    if (ctx && !an) {
      an = window.__probeAnalyser = ctx.createAnalyser();
      an.fftSize = 2048;
      if (node) node.connect(an);
    }
    var peak = 0;
    if (an) {
      await new Promise(function (r) { setTimeout(r, 300); });
      var buf = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(buf);
      for (var i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
    }
    return {
      hasBuffer: !!window.__virtualAudio,
      hasSource: !!node,
      ctxState: ctx ? ctx.state : "none",
      ctxTime: ctx ? ctx.currentTime : 0,
      peak: peak
    };
  };

  var Orig = window.AudioWorkletNode;
  if (!Orig) { window.__pitchErrors.push("AudioWorkletNode 不存在"); return "no-worklet"; }
  function Wrapped(ctx, name, opts) {
    var node = new Orig(ctx, name, opts);
    if (name !== "pitch-scope") return node;
    window.__pitchNodes++;
    window.__pitchCtxs.push(ctx);
    var port = node.port;
    window.__pitchPorts.push(port);
    // 只旁路记录，不要动 port.onmessage：一旦用 defineProperty 覆盖 onmessage，
    // MessagePort 不会被「启动」，worklet 发来的消息会一直排队（实测 0 帧）。
    port.addEventListener("message", function (event) {
      var data = event.data;
      if (data && data.type === "pitch") window.__pitchLog.push(data);
      else if (data && data.type === "config-ack") window.__pitchAck = data;
    });
    return node;
  }
  Wrapped.prototype = Orig.prototype;
  window.AudioWorkletNode = Wrapped;
  return "installed";
})()
`;

async function run(options) {
  const chrome = findChrome();
  const profile = path.resolve(os.tmpdir(), "pitch-scope-e2e-" + Date.now());

  const args = [
    "--headless=new",
    "--no-sandbox",
    "--disable-crash-reporter",
    "--disable-breakpad",
    "--disable-gpu",
    "--mute-audio",
    "--window-size=1440,900",
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--user-data-dir=" + profile,
    "--remote-debugging-port=" + options.port,
    options.url
  ];

  console.log("启动 Chrome：" + chrome);
  const child = spawn(chrome, args, { stdio: ["ignore", "ignore", "ignore"] });

  try {
    await waitForDevtools(options.port, 20000);
    await sleep(1500);

    const targets = await httpJson(`http://127.0.0.1:${options.port}/json/list`);
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("没有找到页面 target");
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);

    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Log.enable");
    await sleep(800);

    const injected = await cdp.evaluate(INJECT);
    const micInfo = await cdp.evaluate(`window.__installVirtualMic(${JSON.stringify(options.wavUrl)})
      .then(function (info) { return JSON.stringify(info); })`);
    console.log(`注入 ${injected} · 虚拟麦克风 ${micInfo}`);

    await cdp.evaluate(`(function(){
      var b = document.getElementById("btnStart");
      if (!b) throw new Error("没有开始按钮");
      b.click();
      return true;
    })()`);


    const started = Date.now();
    while ((Date.now() - started) / 1000 < options.seconds) {
      await sleep(1000);
      const count = await cdp.evaluate("window.__pitchLog.length");
      process.stdout.write(`\r采集 ${count} 帧 / ${options.seconds} s   `);
    }
    process.stdout.write("\n");

    const status = await cdp.evaluate(`(function(){
      var el = document.getElementById("statusText");
      return el ? el.textContent : "";
    })()`);
    const probe = await cdp.evaluate("window.__pitchProbe().then(JSON.stringify)");
    const diag = await cdp.evaluate(`JSON.stringify({
      nodes: window.__pitchNodes,
      ack: window.__pitchAck || null,
      ctx: (window.__pitchCtxs || []).map(function (c) { return c.state + "@" + c.sampleRate; }),
      log: window.__pitchLog.length,
      probe: null
    })`);
    const log = await cdp.evaluate("JSON.stringify(window.__pitchLog)");
    if (options.shot) {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.mkdirSync(path.dirname(path.resolve(options.shot)), { recursive: true });
      fs.writeFileSync(path.resolve(options.shot), Buffer.from(shot.data, "base64"));
      console.log("截图 → " + options.shot);
    }
    const errors = await cdp.evaluate("JSON.stringify(window.__pitchErrors)");
    const consoleErrors = cdp.events
      .filter((e) => e.method === "Runtime.consoleAPICalled" && e.params && e.params.type === "error")
      .map((e) => (e.params.args || []).map((a) => a.value || a.description || "").join(" "));
    const logEntries = cdp.events
      .filter((e) => e.method === "Log.entryAdded" && e.params && e.params.entry && e.params.entry.level === "error")
      .map((e) => e.params.entry.text);
    const pageErrors = cdp.events
      .filter((e) => e.method === "Runtime.exceptionThrown")
      .map((e) => {
        const d = (e.params && e.params.exceptionDetails) || {};
        const ex = d.exception || {};
        return [d.text, ex.description, d.url, d.lineNumber].filter(Boolean).join(" @ ");
      });

    const frames = JSON.parse(log);
    fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    fs.writeFileSync(path.resolve(options.out), JSON.stringify({
      label: options.label,
      url: options.url,
      wavUrl: options.wavUrl,
      pageStatus: status,
      mic: JSON.parse(micInfo),
      diag: JSON.parse(diag),
      injected,
      errors: JSON.parse(errors),
      exceptions: pageErrors,
      consoleErrors,
      logEntries,
      frames
    }, null, 0), "utf8");

    console.log(`状态栏「${status}」· 电平探针 ${probe}`);
    console.log(`采集 ${frames.length} 帧 → ${options.out}`);
    if (pageErrors.length) console.log("页面异常：" + pageErrors.join(" | "));
    if (consoleErrors.length || logEntries.length) {
      console.log("控制台错误：" + consoleErrors.concat(logEntries).join(" | "));
    }
    cdp.close();
    return frames;
  } finally {
    if (!options.keepOpen) {
      try { child.kill(); } catch (err) { /* noop */ }
    }
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (err) { /* noop */ }
  }
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  run(options).then(() => process.exit(0)).catch((err) => {
    console.error("e2e 失败：" + err.message);
    process.exit(1);
  });
}

module.exports = { run, INJECT };
