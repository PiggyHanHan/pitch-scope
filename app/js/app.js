/*!
 * app.js — 音准可视化主线程
 *
 * 结构：
 *   1. 状态与设置
 *   2. 麦克风 / AudioWorklet 启动与停止
 *   3. 检测结果状态机（信号不足 / 低置信度 / 超范围 / 输入过载 / 检测中）
 *   4. Canvas 即时音高曲线
 *   5. 读数、电平、音分条
 *   6. 设置面板、目标音、设备选择
 *
 * 边界：不做评分、不做命中率、不做练习报告；不做全频段频谱。
 */
(function () {
  "use strict";

  var PC = window.PitchCore;

  /* ============================ 常量 ============================ */

  var STORAGE_KEY = "pitchScope.settings.v1";

  var DEFAULT_SETTINGS = {
    version: 2,
    a4: 440,
    minMidi: 36,       // C2
    maxMidi: 84,       // C6
    targetMidi: 69,    // A4
    gateDb: -60,
    confidence: 0.75,
    smoothing: "light",
    windowSec: 15,
    deviceId: "",
    sourceMode: "mic",
    showDebug: false
  };

  var METER_FLOOR_DB = -70;

  var SMOOTH_PRESETS = {
    off: { medianSize: 1, tauMs: 0 },
    light: { medianSize: 3, tauMs: 30 },
    medium: { medianSize: 5, tauMs: 55 }
  };

  var SMOOTH_LABELS = { off: "关闭", light: "轻", medium: "中" };

  var TARGETS = [null, 60, 62, 64, 67, 69]; // 无 / C4 / D4 / E4 / G4 / A4

  var STATUS_TEXT = {
    idle: "未启动",
    starting: "连接中",
    detecting: "检测中",
    "no-signal": "信号不足",
    "low-confidence": "低置信度",
    "out-of-range": "超出范围",
    overload: "输入过载",
    stalled: "音频中断",
    stopped: "已停止",
    error: "不可用"
  };

  var MONO = "\"Cascadia Mono\", Consolas, monospace";

  var COLORS = {
    bg: "#070c0d",
    grid: "rgba(220,232,228,0.055)",
    gridStrong: "rgba(220,232,228,0.13)",
    label: "#708a85",
    labelStrong: "#a9c0ba",
    muted: "#4e6360",
    curve: "#78c9b6",
    target: "#d7b26c",
    targetBand: "rgba(215,178,108,0.055)"
  };

  /* ============================ 状态 ============================ */

  var settings = Object.assign({}, DEFAULT_SETTINGS);

  var state = {
    running: false,
    starting: false,
    ctx: null,
    stream: null,
    source: null,
    node: null,
    sink: null,
    tracker: null,
    history: [],
    current: null,
    status: "idle",
    audioT: 0,
    lastMsgAt: 0,
    msgTimes: [],
    levelDb: -90,
    peakDb: -90,
    peakAt: 0,
    clipRatio: 0,
    windowMs: 85.3,
    hopMs: 21.3,
    lastUi: 0,
    lastDebug: 0,
    toastTimer: null
  };

  var els = {};
  var chart = {
    canvas: null,
    ctx: null,
    wrap: null,
    width: 0,
    height: 0,
    dpr: 1,
    pad: { l: 46, r: 20, t: 18, b: 24 }
  };

  /* ============================ 工具 ============================ */

  function $(id) { return document.getElementById(id); }

  function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }

  function formatCents(cents) {
    var rounded = Math.round(cents);
    if (Math.abs(cents) < 0.5) return "0";
    return (rounded > 0 ? "+" : "−") + Math.abs(rounded);
  }

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  function noteListLabel(midi) {
    return PC.midiToLabel(midi);
  }

  /* ============================ 设置持久化 ============================ */

  function sanitizeSettings(raw) {
    var out = Object.assign({}, DEFAULT_SETTINGS);
    if (!raw || typeof raw !== "object") return out;

    if (typeof raw.a4 === "number" && raw.a4 >= 415 && raw.a4 <= 466) out.a4 = Math.round(raw.a4 * 10) / 10;
    if (typeof raw.minMidi === "number" && raw.minMidi >= 24 && raw.minMidi <= 84) out.minMidi = raw.minMidi;
    if (typeof raw.maxMidi === "number" && raw.maxMidi >= 36 && raw.maxMidi <= 96) out.maxMidi = raw.maxMidi;
    if (out.maxMidi - out.minMidi < 6) { out.minMidi = 36; out.maxMidi = 84; }

    if (raw.targetMidi === null) out.targetMidi = null;
    else if (TARGETS.indexOf(raw.targetMidi) !== -1) out.targetMidi = raw.targetMidi;

    // 旧版本的默认门限是 −45 dB，低声唱歌会被判成“信号不足”；
    // 只迁移一次，避免覆盖用户后来手动设置的值。
    var gateDb = raw.gateDb;
    if (raw.version !== 2 && gateDb === -45) gateDb = -60;
    if (typeof gateDb === "number" && gateDb >= -70 && gateDb <= -20) out.gateDb = gateDb;

    if (typeof raw.confidence === "number" && raw.confidence >= 0.5 && raw.confidence <= 0.95) {
      out.confidence = raw.confidence;
    }
    if (SMOOTH_PRESETS[raw.smoothing]) out.smoothing = raw.smoothing;
    if (raw.windowSec === 10 || raw.windowSec === 15 || raw.windowSec === 30) out.windowSec = raw.windowSec;
    if (typeof raw.deviceId === "string") out.deviceId = raw.deviceId;
    if (raw.sourceMode === "mic" || raw.sourceMode === "system") out.sourceMode = raw.sourceMode;
    out.showDebug = raw.showDebug === true;
    out.version = 2;
    return out;
  }

  function loadSettings() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return Object.assign({}, DEFAULT_SETTINGS);
      return sanitizeSettings(JSON.parse(raw));
    } catch (err) {
      return Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (err) { /* 隐私模式可能禁止写入，忽略 */ }
  }

  /* ============================ 元素缓存 ============================ */

  function cacheEls() {
    [
      "app", "a4Chip", "btnSettings", "notice", "noticeText", "noticeClose",
      "readout", "statusDot", "statusText", "statusExtra",
      "noteDisplay", "noteLetter", "noteOctave", "noteSub",
      "centsValue", "centsCaption", "centsFill", "centsNeedle", "centsTrack",
      "levelDb", "levelFill", "levelPeak", "levelGate", "levelTrack", "levelGateText",
      "freqValue", "noteFreqValue",
      "scopeSub", "chartWrap", "pitchChart", "chartEmpty", "chartHint", "chartStats",
      "debugPanel", "dbgSr", "dbgWindow", "dbgHop", "dbgF0", "dbgAper", "dbgConf",
      "dbgRms", "dbgClip", "dbgRate", "dbgClock",
      "btnStart", "btnStartLabel", "sourceSelect", "deviceSelect",
      "targetLabel", "targetButtons", "btnPlayTarget",
      "rangeLabel", "latencyLabel",
      "settingsDialog", "btnCloseSettings", "inputA4", "a4Presets",
      "selectLow", "selectHigh", "inputGate", "gateValue",
      "inputConfidence", "confidenceValue", "selectSmoothing", "selectWindow",
      "checkboxDebug", "btnRestore", "btnDoneSettings", "toast"
    ].forEach(function (id) { els[id] = $(id); });

    chart.canvas = els.pitchChart;
    chart.wrap = els.chartWrap;
    chart.ctx = chart.canvas.getContext("2d");
  }

  /* ============================ 状态显示 ============================ */

  function setStatus(status) {
    var changed = state.status !== status;
    state.status = status;
    els.readout.dataset.status = status;
    setText(els.statusText, STATUS_TEXT[status] || status);
    if (changed) updateNoteSub();
    updateChartEmpty();
  }

  function updateNoteSub() {
    var text;
    var system = settings.sourceMode === "system";
    switch (state.status) {
      case "detecting":
        text = state.current
          ? "稳定单音 · 置信度 " + Math.round(state.current.confidence * 100) + "%"
          : "稳定单音";
        break;
      case "no-signal":
        text = system
          ? "没有检测到系统声音，或音量低于门限"
          : "没有稳定声音，或音量低于门限";
        break;
      case "low-confidence":
        text = "噪声或气声较大，音高不确定";
        break;
      case "out-of-range":
        text = "当前音高在设定音域之外";
        break;
      case "overload":
        text = system
          ? "输入过载：请降低系统音量"
          : "输入过载：请降低音量或远离麦克风";
        break;
      case "stalled":
        text = system
          ? "系统声音共享已中断，请重新开始检测"
          : "没有收到音频帧，请检查输入设备";
        break;
      case "stopped":
        text = "已停止，曲线保留上一段";
        break;
      case "error":
        text = "音频输入不可用，见上方提示";
        break;
      case "starting":
        text = system
          ? "正在等待选择要共享的屏幕或窗口…"
          : "正在请求麦克风权限…";
        break;
      default:
        text = system
          ? "点击“开始检测”，选择屏幕或窗口并勾选“分享系统音频”"
          : "点击“开始检测”并允许麦克风";
    }
    setText(els.noteSub, text);
  }

  function updateChartEmpty() {
    var text = "";
    var system = settings.sourceMode === "system";
    if (state.history.length === 0) {
      if (!state.running) {
        text = system
          ? "点击“开始检测”，选择屏幕或窗口并勾选“分享系统音频”"
          : "点击“开始检测”，这里会实时绘制音高曲线";
      } else if (state.status === "no-signal") {
        text = system
          ? "信号不足 · 调高系统音量，或在设置里降低门限"
          : "信号不足 · 靠近麦克风或提高音量";
      } else if (state.status === "low-confidence") {
        text = "音高不稳定 · 噪声或气声较大";
      } else if (state.status === "overload") {
        text = "输入过载 · 请降低音量";
      } else if (state.status === "out-of-range") {
        text = "当前音高超出设定音域";
      } else if (state.status === "stalled") {
        text = system
          ? "共享已中断 · 请重新开始检测"
          : "未收到音频帧 · 请检查输入设备";
      } else {
        text = "等待稳定音高…";
      }
    }
    setText(els.chartEmpty, text);
    els.chartEmpty.hidden = !text;
  }

  /* ============================ 读数渲染 ============================ */

  function renderReadout() {
    renderNote();
    renderCents();
    renderFreq();
    renderLevel();
    setText(els.chartStats, "有效点 " + state.history.length);
  }

  function renderNote() {
    var cur = state.current;
    if (!cur) {
      setText(els.noteLetter, "—");
      setText(els.noteOctave, "");
      els.noteDisplay.classList.add("is-empty");
      return;
    }
    els.noteDisplay.classList.remove("is-empty");
    setText(els.noteLetter, cur.note);
    setText(els.noteOctave, String(cur.octave));
  }

  function renderCents() {
    var cur = state.current;
    if (!cur) {
      setText(els.centsValue, "—");
      setText(els.centsCaption, "相对最近音名");
      els.centsNeedle.style.left = "50%";
      els.centsFill.style.left = "50%";
      els.centsFill.style.width = "0%";
      els.centsTrack.classList.add("is-idle");
      els.centsTrack.classList.remove("tone-warn", "tone-alert");
      return;
    }

    var cents = cur.cents;
    var abs = Math.abs(cents);
    els.centsTrack.classList.remove("is-idle", "tone-warn", "tone-alert");
    if (abs > 20) els.centsTrack.classList.add("tone-alert");
    else if (abs > 5) els.centsTrack.classList.add("tone-warn");

    setText(els.centsValue, formatCents(cents));
    var word = abs <= 1 ? "在音准附近" : (cents > 0 ? "偏高" : "偏低");
    setText(els.centsCaption, word + " · 相对 " + cur.label);

    var pos = PC.clamp(50 + cents, 0, 100);
    els.centsNeedle.style.left = pos + "%";
    els.centsFill.style.left = Math.min(50, pos) + "%";
    els.centsFill.style.width = Math.abs(pos - 50) + "%";
  }

  function renderFreq() {
    var cur = state.current;
    setText(els.freqValue, cur ? cur.f0.toFixed(1) + " Hz" : "—");
    setText(els.noteFreqValue, cur ? cur.targetFreq.toFixed(1) + " Hz" : "—");
  }

  function renderLevel() {
    var db = state.levelDb;
    var pct = clamp01((db - METER_FLOOR_DB) / -METER_FLOOR_DB) * 100;
    els.levelFill.style.width = pct.toFixed(1) + "%";

    var peakPct = clamp01((state.peakDb - METER_FLOOR_DB) / -METER_FLOOR_DB) * 100;
    els.levelPeak.style.left = peakPct.toFixed(1) + "%";

    var gatePct = clamp01((settings.gateDb - METER_FLOOR_DB) / -METER_FLOOR_DB) * 100;
    els.levelGate.style.left = gatePct.toFixed(1) + "%";
    els.levelGateText.style.left = gatePct.toFixed(1) + "%";
    els.levelGateText.style.transform = gatePct < 15 ? "none" : "translateX(-50%)";

    setText(els.levelDb, db > -90 ? db.toFixed(0) + " dB" : "—");
    setText(els.levelGateText, "门限 " + settings.gateDb + " dB");

    els.levelTrack.classList.toggle("is-hot", db > -12 && db <= -6);
    els.levelTrack.classList.toggle("is-clip", db > -6 || state.clipRatio > 0.05);
  }

  function renderDebug(msg) {
    setText(els.dbgSr, (msg.sampleRate / 1000).toFixed(1) + " kHz");
    setText(els.dbgWindow, msg.windowMs.toFixed(1) + " ms");
    setText(els.dbgHop, msg.hopMs.toFixed(1) + " ms");
    setText(els.dbgF0, msg.rawF0 > 0 ? msg.rawF0.toFixed(2) + " Hz" : "—");
    setText(els.dbgAper, msg.aperiodicity.toFixed(3));
    setText(els.dbgConf, (msg.confidence * 100).toFixed(1) + "%");
    setText(els.dbgRms, msg.rms.toFixed(4));
    setText(els.dbgClip, (msg.clipRatio * 100).toFixed(1) + "%");
    setText(els.dbgRate, state.msgTimes.length + " 帧/s");
    setText(els.dbgClock, msg.tEnd.toFixed(2) + " s");
  }

  /* ============================ 目标音 / 标签 ============================ */

  function buildTargetButtons() {
    els.targetButtons.innerHTML = "";
    TARGETS.forEach(function (midi) {
      var button = document.createElement("button");
      button.type = "button";
      button.dataset.midi = midi === null ? "0" : String(midi);
      button.textContent = midi === null ? "无" : noteListLabel(midi);
      button.addEventListener("click", function () {
        settings.targetMidi = midi;
        saveSettings();
        updateTargetPressed();
        drawChart();
        toast(midi === null ? "已关闭目标音参考线" : "目标音：" + noteListLabel(midi));
      });
      els.targetButtons.appendChild(button);
    });
    updateTargetPressed();
  }

  function updateTargetPressed() {
    Array.prototype.forEach.call(els.targetButtons.children, function (btn) {
      var midi = Number(btn.dataset.midi);
      var selected = settings.targetMidi === null
        ? midi === 0
        : midi === settings.targetMidi;
      btn.setAttribute("aria-pressed", selected ? "true" : "false");
    });
  }

  function updateA4Labels() {
    setText(els.a4Chip, "A4 = " + settings.a4.toFixed(1) + " Hz");
    var loHz = PC.midiToFreq(settings.minMidi, settings.a4);
    var hiHz = PC.midiToFreq(settings.maxMidi, settings.a4);
    setText(els.rangeLabel,
      "音域 " + PC.midiToLabel(settings.minMidi) + "–" + PC.midiToLabel(settings.maxMidi) +
      " · " + loHz.toFixed(0) + "–" + hiHz.toFixed(0) + " Hz");
  }

  function updateScopeLabels() {
    setText(els.scopeSub, "时间–音高曲线 · " + settings.windowSec + " 秒窗口");
    setText(els.chartHint, "纵轴：CDEFGAB 音名 · 横轴：最近 " + settings.windowSec + " 秒");
  }

  function updateLatencyLabel() {
    var ms = Math.round(state.windowMs / 2 + state.hopMs + 18);
    setText(els.latencyLabel, "延迟约 " + ms + " ms");
  }

  /* ============================ 音量 / 峰值 ============================ */

  function trackRate() {
    var now = performance.now();
    state.msgTimes.push(now);
    while (state.msgTimes.length && state.msgTimes[0] < now - 1000) state.msgTimes.shift();
  }

  /* ============================ 检测结果状态机 ============================ */

  /** 依据当前设置重建逐帧状态机（音域 / A4 / 门限 / 置信度 / 平滑档）。 */
  function createTracker() {
    return PC.createTracker({
      a4: settings.a4,
      minMidi: settings.minMidi,
      maxMidi: settings.maxMidi,
      gateDb: settings.gateDb,
      confidence: settings.confidence,
      smoothing: SMOOTH_PRESETS[settings.smoothing] || SMOOTH_PRESETS.light
    });
  }

  /** 设置变化时热更新状态机，避免切换音域后仍按旧范围判定。 */
  function applyTrackerSettings(reset) {
    if (!state.tracker) {
      state.tracker = createTracker();
      return;
    }
    state.tracker.configure({
      a4: settings.a4,
      minMidi: settings.minMidi,
      maxMidi: settings.maxMidi,
      gateDb: settings.gateDb,
      confidence: settings.confidence,
      smoothing: SMOOTH_PRESETS[settings.smoothing] || SMOOTH_PRESETS.light
    });
    if (reset) state.tracker.reset();
  }

  function handlePitch(msg) {
    state.lastMsgAt = performance.now();
    state.audioT = msg.tEnd;
    state.windowMs = msg.windowMs;
    state.hopMs = msg.hopMs;
    state.levelDb = msg.db;
    state.clipRatio = msg.clipRatio;

    if (msg.db > state.peakDb) {
      state.peakDb = msg.db;
      state.peakAt = performance.now();
    } else if (performance.now() - state.peakAt > 900) {
      state.peakDb = msg.db;
    }

    trackRate();

    if (settings.showDebug && performance.now() - state.lastDebug > 200) {
      state.lastDebug = performance.now();
      renderDebug(msg);
    }

    if (!state.running) return;

    // 判定、平滑、读数保持都在 PitchCore.PitchTracker 里（纯计算，可 Node 回归）。
    if (!state.tracker) state.tracker = createTracker();
    var result = state.tracker.track(msg);

    if (result.status !== "detecting" || !result.current) {
      state.current = null;
      setStatus(result.status);
      return;
    }

    state.current = result.current;
    if (result.point) state.history.push(result.point);
    setStatus("detecting");
  }

  /* ============================ 音频启动 / 停止 ============================ */

  function freqBounds() {
    return {
      minFreq: PC.midiToFreq(settings.minMidi, settings.a4) * 0.98,
      maxFreq: PC.midiToFreq(settings.maxMidi, settings.a4) * 1.02
    };
  }

  function postConfig() {
    if (!state.node) return;
    var bounds = freqBounds();
    state.node.port.postMessage({
      type: "config",
      minFreq: bounds.minFreq,
      maxFreq: bounds.maxFreq
    });
  }

  function describeError(err) {
    if (!err) return "无法启动音频输入。";
    if (err.code === "FILE_PROTOCOL") {
      return "不要直接双击 HTML 打开。请双击 start.bat，或运行 python tools/serve.py，然后访问 http://127.0.0.1:8123/pitch-scope.html。";
    }
    if (err.code === "SECURE_CONTEXT") {
      return "当前不是安全上下文，浏览器禁止音频采集。请通过 http://127.0.0.1:8123 打开本页。";
    }
    if (err.code === "NO_MEDIA") {
      return "这个浏览器不支持音频采集（navigator.mediaDevices 不可用）。请使用 Chrome 或 Edge。";
    }
    if (err.code === "NO_WORKLET") {
      return "这个浏览器不支持 AudioWorklet。请使用较新的 Chrome / Edge。";
    }
    if (err.code === "NO_DISPLAY") {
      return "这个浏览器不支持系统声音采集。请使用 Chrome 或 Edge，并在开始检测时选择“整个屏幕”并勾选“分享系统音频”。";
    }
    if (err.code === "NO_SYSTEM_AUDIO") {
      return "这次共享没有包含音频。请重新点击“开始检测”，在共享窗口里勾选“分享系统音频”或“分享标签页音频”。";
    }

    switch (err.name) {
      case "NotAllowedError":
      case "PermissionDeniedError":
      case "AbortError":
        return settings.sourceMode === "system"
          ? "系统声音共享被取消，或浏览器拒绝了屏幕共享权限。请重新点击“开始检测”并勾选分享音频。"
          : "麦克风权限被拒绝。请在浏览器地址栏的站点设置里允许麦克风，然后重新点击“开始检测”。";
      case "NotFoundError":
      case "DevicesNotFoundError":
        return "没有找到可用的输入设备。请连接麦克风后重试。";
      case "NotReadableError":
      case "TrackStartError":
        return "麦克风被其他程序占用（例如会议软件）。请关闭占用后重试。";
      case "NotSupportedError":
        return settings.sourceMode === "system"
          ? "当前浏览器不支持系统声音共享。请使用 Chrome 或 Edge。"
          : "当前浏览器不支持这种音频输入。请使用 Chrome 或 Edge。";
      case "OverconstrainedError":
        return settings.sourceMode === "system"
          ? "系统声音共享参数不被支持，请换一个共享源后重试。"
          : "所选输入设备不可用，请重新选择输入设备。";
      case "SecurityError":
        return "浏览器安全策略阻止了音频采集。请通过本地地址 http://127.0.0.1:8123 打开本页。";
      default:
        return "无法启动音频输入：" + (err.message || err.name || "未知错误");
    }
  }

  async function acquireInputStream() {
    if (settings.sourceMode === "system") {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        throw { code: "NO_DISPLAY" };
      }

      var displayStream;
      try {
        displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 2, max: 5 } },
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        });
      } catch (err) {
        // 某些实现不接受视频帧率约束，退回最简参数再试一次。
        if (err && (err.name === "OverconstrainedError" || err.name === "TypeError")) {
          displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        } else {
          throw err;
        }
      }

      if (!displayStream.getAudioTracks().length) {
        displayStream.getTracks().forEach(function (track) {
          try { track.stop(); } catch (e) { /* noop */ }
        });
        throw { code: "NO_SYSTEM_AUDIO" };
      }
      return displayStream;
    }

    var audioConstraints = {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    };
    if (settings.deviceId) audioConstraints.deviceId = { exact: settings.deviceId };

    try {
      return await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
    } catch (err) {
      if (err && err.name === "OverconstrainedError" && settings.deviceId) {
        settings.deviceId = "";
        saveSettings();
        delete audioConstraints.deviceId;
        await refreshDevices();
        return await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
      }
      throw err;
    }
  }

  async function start() {
    if (state.starting || state.running) return;

    state.starting = true;
    els.btnStart.disabled = true;
    els.sourceSelect.disabled = true;
    setStatus("starting");
    hideNotice();

    var stream = null;

    try {
      if (location.protocol === "file:") throw { code: "FILE_PROTOCOL" };
      if (!window.isSecureContext) throw { code: "SECURE_CONTEXT" };
      if (settings.sourceMode === "system") {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) throw { code: "NO_DISPLAY" };
      } else if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw { code: "NO_MEDIA" };
      }
      if (typeof AudioWorkletNode === "undefined") throw { code: "NO_WORKLET" };

      stream = await acquireInputStream();

      var ctx = new AudioContext({ latencyHint: "interactive" });
      state.ctx = ctx;

      await ctx.audioWorklet.addModule("js/pitch-core.js");
      await ctx.audioWorklet.addModule("js/pitch-worklet.js");

      var bounds = freqBounds();
      var node = new AudioWorkletNode(ctx, "pitch-scope", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
        processorOptions: {
          windowSize: 4096,
          hopSize: 1024,
          decimation: 2,
          minFreq: bounds.minFreq,
          maxFreq: bounds.maxFreq
        }
      });

      node.port.onmessage = function (event) {
        if (event.data && event.data.type === "pitch") handlePitch(event.data);
      };
      node.onprocessorerror = function () {
        showNotice("音频处理线程异常。请刷新页面后重试。");
        stop("error");
      };

      var source = ctx.createMediaStreamSource(stream);
      var sink = ctx.createGain();
      sink.gain.value = 0; // 静音接地，避免麦克风回授

      source.connect(node);
      node.connect(sink);
      sink.connect(ctx.destination);

      if (ctx.state === "suspended") await ctx.resume();

      state.stream = stream;
      state.node = node;
      state.source = source;
      state.sink = sink;
      state.running = true;
      state.starting = false;
      state.history = [];
      state.current = null;
      state.levelDb = -90;
      state.peakDb = -90;
      state.clipRatio = 0;
      state.lastMsgAt = performance.now();
      state.tracker = createTracker();

      var system = settings.sourceMode === "system";
      stream.getAudioTracks().forEach(function (track) {
        track.addEventListener("ended", function () {
          if (!state.running) return;
          if (system) {
            showNotice("系统声音共享已结束，检测已停止。");
            stop("source-ended");
          } else {
            showNotice("输入设备已断开，检测已停止。");
            stop("device");
          }
        });
      });

      els.btnStart.dataset.running = "true";
      setText(els.btnStartLabel, "停止检测");
      els.btnStart.setAttribute("aria-label", "停止检测");
      setStatus("no-signal");
      updateLatencyLabel();
      await refreshDevices();
      toast(system ? "已开始检测：正在分析系统声音" : "已开始检测：对着麦克风唱一个稳定的单音");
    } catch (err) {
      if (stream) {
        stream.getTracks().forEach(function (track) {
          try { track.stop(); } catch (e) { /* noop */ }
        });
      }
      teardown();
      state.starting = false;
      setStatus("error");
      showNotice(describeError(err));
      if (window.console) console.error("[pitch-scope]", err);
    } finally {
      els.btnStart.disabled = false;
      els.sourceSelect.disabled = false;
    }
  }

  function teardown() {
    if (state.node) {
      try {
        state.node.port.onmessage = null;
        state.node.disconnect();
      } catch (e) { /* noop */ }
    }
    if (state.source) { try { state.source.disconnect(); } catch (e) { /* noop */ } }
    if (state.sink) { try { state.sink.disconnect(); } catch (e) { /* noop */ } }
    if (state.stream) {
      state.stream.getTracks().forEach(function (track) {
        try { track.stop(); } catch (e) { /* noop */ }
      });
    }
    if (state.ctx && state.ctx.state !== "closed") {
      try { state.ctx.close(); } catch (e) { /* noop */ }
    }
    state.node = null;
    state.source = null;
    state.sink = null;
    state.stream = null;
    state.ctx = null;
  }

  function stop(reason) {
    var wasRunning = state.running;

    state.running = false;
    state.starting = false;
    teardown();
    state.current = null;
    if (state.tracker) state.tracker.reset();
    state.levelDb = -90;
    state.peakDb = -90;
    state.clipRatio = 0;
    renderReadout();

    els.btnStart.dataset.running = "false";
    setText(els.btnStartLabel, "开始检测");
    els.btnStart.setAttribute("aria-label", "开始检测");
    els.btnStart.disabled = false;

    if (reason === "device") {
      setStatus("stalled");
    } else if (reason === "error") {
      setStatus("error");
    } else if (wasRunning) {
      setStatus("stopped");
    } else {
      setStatus("idle");
    }
  }

  function toggleRunning() {
    if (state.running) stop("user");
    else start();
  }

  /* ============================ 输入设备 ============================ */

  async function refreshDevices() {
    if (!els.deviceSelect) return;

    if (settings.sourceMode === "system") {
      els.deviceSelect.disabled = true;
      els.deviceSelect.innerHTML = "";
      var sharedOption = document.createElement("option");
      sharedOption.value = "";
      sharedOption.textContent = "共享屏幕时选择";
      els.deviceSelect.appendChild(sharedOption);
      return;
    }

    els.deviceSelect.disabled = false;
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;

    try {
      var devices = await navigator.mediaDevices.enumerateDevices();
      var inputs = devices.filter(function (d) { return d.kind === "audioinput"; });
      var current = settings.deviceId;
      var found = false;

      els.deviceSelect.innerHTML = "";

      var defaultOption = document.createElement("option");
      defaultOption.value = "";
      defaultOption.textContent = "默认输入设备";
      els.deviceSelect.appendChild(defaultOption);

      inputs.forEach(function (device, index) {
        var option = document.createElement("option");
        option.value = device.deviceId;
        option.textContent = device.label || ("输入设备 " + (index + 1));
        els.deviceSelect.appendChild(option);
        if (device.deviceId === current) found = true;
      });

      if (current && !found) {
        settings.deviceId = "";
        saveSettings();
      }
      els.deviceSelect.value = found ? current : "";
    } catch (err) {
      /* 权限未授予时标签可能为空，忽略即可 */
    }
  }

  function updateSourceUI() {
    var system = settings.sourceMode === "system";
    if (els.sourceSelect) els.sourceSelect.value = settings.sourceMode;

    var deviceLabel = document.querySelector('label[for="deviceSelect"]');
    if (deviceLabel) deviceLabel.textContent = system ? "共享源" : "输入设备";

    if (els.deviceSelect) els.deviceSelect.disabled = system;
    refreshDevices();
    updateNoteSub();
    updateChartEmpty();
  }

  function setSourceMode(mode) {
    if (mode !== "mic" && mode !== "system") return;
    if (settings.sourceMode === mode) return;
    if (state.starting) {
      els.sourceSelect.value = settings.sourceMode;
      toast("正在连接音频，请稍后再切换来源");
      return;
    }

    settings.sourceMode = mode;
    saveSettings();
    updateSourceUI();

    if (state.running) {
      stop("user");
      setTimeout(function () { start(); }, 80);
    }

    if (mode === "system") {
      toast("已切换：开始检测时选择整个屏幕，并勾选“分享系统音频”");
    } else {
      toast("已切换到麦克风");
    }
  }

  /* ============================ 设置面板 ============================ */

  function buildRangeOptions() {
    fillNoteSelect(els.selectLow, 24, Math.min(84, settings.maxMidi - 6));
    fillNoteSelect(els.selectHigh, Math.max(36, settings.minMidi + 6), 96);
    els.selectLow.value = String(settings.minMidi);
    els.selectHigh.value = String(settings.maxMidi);
  }

  function fillNoteSelect(select, fromMidi, toMidi) {
    select.innerHTML = "";
    for (var midi = fromMidi; midi <= toMidi; midi++) {
      var option = document.createElement("option");
      option.value = String(midi);
      option.textContent = PC.midiToLabel(midi);
      select.appendChild(option);
    }
  }

  function applySettingsToUI() {
    els.inputA4.value = settings.a4.toFixed(1);
    els.inputGate.value = String(settings.gateDb);
    els.gateValue.textContent = "−" + Math.abs(settings.gateDb) + " dB";
    els.inputConfidence.value = String(Math.round(settings.confidence * 100));
    els.confidenceValue.textContent = Math.round(settings.confidence * 100) + "%";
    els.selectSmoothing.value = settings.smoothing;
    els.selectWindow.value = String(settings.windowSec);
    els.checkboxDebug.checked = settings.showDebug;
    els.debugPanel.hidden = !settings.showDebug;
    buildRangeOptions();
    updateTargetPressed();
    updateA4Labels();
    updateScopeLabels();
    updateSourceUI();
    renderLevel();
  }

  function resetSignalState() {
    state.history = [];
    state.current = null;
    applyTrackerSettings(true);
    updateNoteSub();
    updateChartEmpty();
    renderReadout();
  }

  function applyA4(value, announce) {
    var a4 = Number(value);
    if (!isFinite(a4) || a4 < 415 || a4 > 466) {
      toast("A4 参考频率需在 415–466 Hz 之间");
      els.inputA4.value = settings.a4.toFixed(1);
      return false;
    }
    if (Math.abs(a4 - settings.a4) < 1e-9) return true;

    settings.a4 = Math.round(a4 * 10) / 10;
    saveSettings();
    els.inputA4.value = settings.a4.toFixed(1);
    updateA4Labels();
    resetSignalState();
    if (state.running) postConfig();
    if (announce) toast("A4 = " + settings.a4.toFixed(1) + " Hz · 音名映射已更新");
    return true;
  }

  function applyLowMidi(value) {
    var low = Number(value);
    if (!isFinite(low)) return;
    settings.minMidi = low;
    if (settings.maxMidi - settings.minMidi < 6) {
      settings.maxMidi = Math.min(96, settings.minMidi + 6);
    }
    saveSettings();
    buildRangeOptions();
    updateA4Labels();
    resetSignalState();
    if (state.running) postConfig();
  }

  function applyHighMidi(value) {
    var high = Number(value);
    if (!isFinite(high)) return;
    settings.maxMidi = high;
    if (settings.maxMidi - settings.minMidi < 6) {
      settings.minMidi = Math.max(24, settings.maxMidi - 6);
    }
    saveSettings();
    buildRangeOptions();
    updateA4Labels();
    resetSignalState();
    if (state.running) postConfig();
  }

  function openSettings() {
    applySettingsToUI();
    if (typeof els.settingsDialog.showModal === "function") {
      els.settingsDialog.showModal();
    } else {
      els.settingsDialog.setAttribute("open", "open");
    }
  }

  function closeSettings() {
    if (typeof els.settingsDialog.close === "function") {
      els.settingsDialog.close();
    } else {
      els.settingsDialog.removeAttribute("open");
    }
  }

  /* ============================ 目标音试听 ============================ */

  function playTargetTone() {
    if (settings.targetMidi === null) {
      toast("先选择一个目标音");
      return;
    }

    var freq = PC.midiToFreq(settings.targetMidi, settings.a4);
    var ctx = (state.ctx && state.ctx.state === "running") ? state.ctx : null;
    var temporary = false;

    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      temporary = true;
    }
    if (ctx.state === "suspended") {
      ctx.resume().catch(function () {});
    }

    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    var t0 = ctx.currentTime + 0.05;
    var dur = 1.2;
    var level = 0.3;

    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(level, t0 + 0.012);
    gain.gain.setValueAtTime(level, t0 + dur - 0.05);
    gain.gain.linearRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);

    osc.onended = function () {
      try { gain.disconnect(); } catch (e) { /* noop */ }
      if (temporary) {
        try { ctx.close(); } catch (e) { /* noop */ }
      }
    };

    toast("试听 " + PC.midiToLabel(settings.targetMidi) + " · " + freq.toFixed(1) + " Hz（麦克风会拾取到）");
  }

  /* ============================ Canvas 绘制 ============================ */

  function resizeChart() {
    var rect = chart.wrap.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;

    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    chart.width = rect.width;
    chart.height = rect.height;
    chart.dpr = dpr;

    chart.canvas.width = Math.round(rect.width * dpr);
    chart.canvas.height = Math.round(rect.height * dpr);
    chart.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    drawChart();
  }

  function drawChart() {
    var ctx = chart.ctx;
    var width = chart.width;
    var height = chart.height;
    if (!ctx || width < 10 || height < 10) return;

    ctx.setTransform(chart.dpr, 0, 0, chart.dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, width, height);

    var pad = chart.pad;
    var plotX = pad.l;
    var plotY = pad.t;
    var plotW = Math.max(10, width - pad.l - pad.r);
    var plotH = Math.max(10, height - pad.t - pad.b);

    var yMin = settings.minMidi;
    var yMax = settings.maxMidi;
    var span = Math.max(1, yMax - yMin);
    var now = state.audioT || 0;
    var windowSec = settings.windowSec;

    var yOf = function (midi) {
      return plotY + ((yMax - midi) / span) * plotH;
    };
    var xOf = function (t) {
      return plotX + plotW - ((now - t) / windowSec) * plotW;
    };

    /* 历史裁剪 */
    var cutoff = now - windowSec - 2;
    while (state.history.length && state.history[0].t < cutoff) state.history.shift();

    /* 时间网格 */
    var timeStep = windowSec >= 30 ? 5 : 1;
    var minorEvery = windowSec >= 30 ? 1 : 1;
    ctx.font = "10px " + MONO;
    for (var sec = 0; sec <= windowSec; sec += minorEvery) {
      var gx = plotX + plotW - (sec / windowSec) * plotW;
      var major = sec % timeStep === 0;
      ctx.strokeStyle = major ? COLORS.gridStrong : COLORS.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(gx, plotY);
      ctx.lineTo(gx, plotY + plotH);
      ctx.stroke();

      if (major) {
        ctx.fillStyle = COLORS.muted;
        ctx.textAlign = "center";
        var label = sec === 0 ? "0" : "−" + sec;
        var labelX = Math.min(Math.max(gx, plotX + 12), plotX + plotW - 10);
        ctx.fillText(label, labelX, height - 8);
      }
    }

    /* 音名网格 */
    var spacing = plotH / span;
    var labelMode = spacing >= 10 ? "natural" : spacing >= 6 ? "c-and-a" : "c";
    var midiLo = Math.floor(yMin);
    var midiHi = Math.ceil(yMax);
    var lastLabelY = -100;

    for (var midi = midiLo; midi <= midiHi; midi++) {
      var gy = yOf(midi);
      if (gy < plotY - 1 || gy > plotY + plotH + 1) continue;

      var pc = ((midi % 12) + 12) % 12;
      var isC = pc === 0;
      var natural = pc === 0 || pc === 2 || pc === 4 || pc === 5 || pc === 7 || pc === 9 || pc === 11;

      // 四个八度挤在 ~350px 时，每条半音线都会糊成一片；默认只画自然音级，
      // 音域收窄、间距变大之后再恢复半音网格。
      if (!isC && !(natural && spacing >= 5) && spacing < 9) continue;

      ctx.strokeStyle = isC ? COLORS.gridStrong : COLORS.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plotX, gy);
      ctx.lineTo(plotX + plotW, gy);
      ctx.stroke();

      var shouldLabel = false;
      if (isC) shouldLabel = true;
      else if (labelMode === "natural") shouldLabel = natural;
      else if (labelMode === "c-and-a") shouldLabel = natural && (pc === 9);
      else shouldLabel = false;

      if (!shouldLabel) continue;
      if (!isC && Math.abs(gy - lastLabelY) < 9) continue;

      ctx.textAlign = "right";
      if (isC) {
        ctx.fillStyle = COLORS.labelStrong;
        ctx.font = "600 10.5px " + MONO;
        ctx.fillText(PC.midiToLabel(midi), plotX - 7, gy + 3.5);
      } else if (pc === 9) {
        ctx.fillStyle = COLORS.labelStrong;
        ctx.font = "10px " + MONO;
        ctx.fillText(PC.midiToLabel(midi), plotX - 7, gy + 3.5);
      } else {
        ctx.fillStyle = COLORS.label;
        ctx.font = "10px " + MONO;
        ctx.fillText(PC.NOTE_NAMES[pc], plotX - 7, gy + 3.5);
      }
      lastLabelY = gy;
    }

    /* 目标音参考线与 ±50 cents 带 */
    if (settings.targetMidi !== null) {
      var targetY = yOf(settings.targetMidi);
      if (targetY >= plotY - 1 && targetY <= plotY + plotH + 1) {
        var halfBand = (0.5 / span) * plotH;
        ctx.fillStyle = COLORS.targetBand;
        ctx.fillRect(plotX, targetY - halfBand, plotW, halfBand * 2);

        ctx.save();
        ctx.beginPath();
        ctx.rect(plotX, plotY, plotW, plotH);
        ctx.clip();
        ctx.strokeStyle = COLORS.target;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(plotX, targetY);
        ctx.lineTo(plotX + plotW, targetY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        var targetText = "目标 " + PC.midiToLabel(settings.targetMidi) + " · " +
          PC.midiToFreq(settings.targetMidi, settings.a4).toFixed(1) + " Hz";
        ctx.font = "10px " + MONO;
        var textWidth = ctx.measureText(targetText).width;
        var labelY = targetY - 6;
        if (labelY < plotY + 12) labelY = targetY + 14;
        var labelLeft = plotX + 20;
        ctx.fillStyle = COLORS.bg;
        ctx.fillRect(labelLeft - 4, labelY - 9, textWidth + 8, 13);
        ctx.fillStyle = COLORS.target;
        ctx.textAlign = "left";
        ctx.fillText(targetText, labelLeft, labelY);
      }
    }

    /* 音高曲线 */
    if (state.history.length) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(plotX, plotY, plotW, plotH);
      ctx.clip();

      ctx.strokeStyle = COLORS.curve;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();

      var prev = null;
      var segStart = null;
      var segCount = 0;

      for (var i = 0; i < state.history.length; i++) {
        var point = state.history[i];
        if (point.t < now - windowSec - 1 || point.t > now + 0.5) continue;
        var px = xOf(point.t);
        var py = yOf(point.midi);

        if (!prev || point.t - prev.t > 0.22) {
          if (segCount === 1 && segStart) drawDot(ctx, xOf(segStart.t), yOf(segStart.midi), 1.6);
          ctx.moveTo(px, py);
          segStart = point;
          segCount = 1;
        } else {
          ctx.lineTo(px, py);
          segCount++;
        }
        prev = point;
      }
      ctx.stroke();
      if (segCount === 1 && segStart) drawDot(ctx, xOf(segStart.t), yOf(segStart.midi), 1.6);
      ctx.restore();
    }

    /* 当前音高点 + 水平指示 */
    var cur = state.current;
    if (cur && state.running && now - cur.t < 0.3) {
      var cx = xOf(cur.t);
      var cy = yOf(cur.midiFloat);
      ctx.save();
      ctx.beginPath();
      ctx.rect(plotX, plotY, plotW, plotH);
      ctx.clip();
      ctx.strokeStyle = "rgba(120,201,182,0.28)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(plotX + plotW, cy);
      ctx.stroke();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.bg;
      ctx.fill();
      ctx.strokeStyle = COLORS.curve;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    /* 坐标轴 */
    ctx.strokeStyle = COLORS.gridStrong;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotX, plotY);
    ctx.lineTo(plotX, plotY + plotH);
    ctx.lineTo(plotX + plotW, plotY + plotH);
    ctx.stroke();
  }

  function drawDot(ctx, x, y, radius) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.curve;
    ctx.fill();
  }

  /* ============================ 主循环 ============================ */

  function tick(timestamp) {
    requestAnimationFrame(tick);

    if (timestamp - state.lastUi >= 50) {
      state.lastUi = timestamp;
      renderReadout();
    }
    drawChart();
  }

  function watchdog() {
    if (!state.running) return;

    if (performance.now() - state.lastMsgAt > 1500) {
      state.current = null;
      if (state.tracker) state.tracker.reset();
      setStatus("stalled");
    }
    updateLatencyLabel();
  }

  /* ============================ 提示 ============================ */

  function showNotice(text) {
    els.noticeText.textContent = text;
    els.notice.hidden = false;
  }

  function hideNotice() {
    els.notice.hidden = true;
  }

  function toast(text) {
    els.toast.textContent = text;
    els.toast.classList.add("show");
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () {
      els.toast.classList.remove("show");
    }, 2600);
  }

  /* ============================ 事件绑定 ============================ */

  function bindEvents() {
    els.btnStart.addEventListener("click", toggleRunning);

    els.btnSettings.addEventListener("click", openSettings);
    els.a4Chip.addEventListener("click", openSettings);
    els.btnCloseSettings.addEventListener("click", closeSettings);
    els.btnDoneSettings.addEventListener("click", closeSettings);

    els.settingsDialog.addEventListener("click", function (event) {
      if (event.target === els.settingsDialog) closeSettings();
    });

    els.inputA4.addEventListener("change", function () {
      applyA4(els.inputA4.value, true);
    });

    els.a4Presets.addEventListener("click", function (event) {
      var button = event.target.closest ? event.target.closest("button[data-a4]") : null;
      if (!button) return;
      applyA4(button.dataset.a4, true);
    });

    els.selectLow.addEventListener("change", function () {
      applyLowMidi(els.selectLow.value);
    });
    els.selectHigh.addEventListener("change", function () {
      applyHighMidi(els.selectHigh.value);
    });

    els.inputGate.addEventListener("input", function () {
      settings.gateDb = Number(els.inputGate.value);
      els.gateValue.textContent = "−" + Math.abs(settings.gateDb) + " dB";
      saveSettings();
      applyTrackerSettings(false);
      renderLevel();
    });

    els.inputConfidence.addEventListener("input", function () {
      settings.confidence = Number(els.inputConfidence.value) / 100;
      els.confidenceValue.textContent = Math.round(settings.confidence * 100) + "%";
      saveSettings();
      applyTrackerSettings(true);
    });

    els.selectSmoothing.addEventListener("change", function () {
      settings.smoothing = els.selectSmoothing.value;
      saveSettings();
      applyTrackerSettings(true);
    });

    els.selectWindow.addEventListener("change", function () {
      settings.windowSec = Number(els.selectWindow.value);
      saveSettings();
      updateScopeLabels();
      updateChartEmpty();
      drawChart();
    });

    els.checkboxDebug.addEventListener("change", function () {
      settings.showDebug = els.checkboxDebug.checked;
      saveSettings();
      els.debugPanel.hidden = !settings.showDebug;
      if (settings.showDebug) els.debugPanel.open = true;
    });

    els.btnRestore.addEventListener("click", function () {
      var deviceId = settings.deviceId;
      settings = sanitizeSettings(Object.assign({}, DEFAULT_SETTINGS, { deviceId: deviceId }));
      saveSettings();
      applySettingsToUI();
      resetSignalState();
      if (state.running) postConfig();
      toast("已恢复默认设置");
    });

    els.sourceSelect.addEventListener("change", function () {
      setSourceMode(els.sourceSelect.value);
    });

    els.deviceSelect.addEventListener("change", function () {
      settings.deviceId = els.deviceSelect.value;
      saveSettings();
      if (state.running) {
        stop("user");
        setTimeout(function () { start(); }, 60);
      }
    });

    els.btnPlayTarget.addEventListener("click", playTargetTone);

    els.noticeClose.addEventListener("click", hideNotice);

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) resizeChart();
    });

    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener("devicechange", refreshDevices);
    }
  }

  /* ============================ 初始化 ============================ */

  function init() {
    if (!PC) {
      showNotice("核心模块 pitch-core.js 未加载。请通过 start.bat 启动本地服务后再打开页面。");
      return;
    }

    cacheEls();
    settings = loadSettings();
    buildTargetButtons();
    applySettingsToUI();
    bindEvents();

    chart.canvas = els.pitchChart;
    chart.wrap = els.chartWrap;
    resizeChart();

    if (window.ResizeObserver) {
      new ResizeObserver(resizeChart).observe(chart.wrap);
    } else {
      window.addEventListener("resize", resizeChart);
    }

    if (location.protocol === "file:") {
      showNotice("当前是直接打开本地文件，麦克风 / 系统声音与 AudioWorklet 会被浏览器拦截。请双击 start.bat，或运行 python tools\serve.py，然后访问 http://127.0.0.1:8123/pitch-scope.html。");
    }

    setStatus("idle");
    updateScopeLabels();
    updateChartEmpty();
    renderReadout();
    updateLatencyLabel();

    requestAnimationFrame(tick);
    setInterval(watchdog, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
