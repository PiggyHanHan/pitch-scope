/*!
 * browser-smoke.mjs — 用 Chrome 的假麦克风做一次端到端冒烟测试
 *
 * 前置：
 *   1. python tools/serve.py --no-browser --port 8123
 *   2. Chrome 以 --remote-debugging-port=9229 启动，并带：
 *        --use-fake-ui-for-media-stream
 *        --use-fake-device-for-media-stream
 *        --use-file-for-fake-audio-capture=<a4.wav 绝对路径>
 *        --autoplay-policy=no-user-gesture-required
 *
 * 运行：node tests/browser-smoke.mjs
 * 输出：app/_shots/smoke.png + 终端 JSON
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CDP_PORT || 9229);
const PAGE_URL = process.env.PAGE_URL || "http://127.0.0.1:8123/pitch-scope.html";
const EXPECT_STATUS = process.env.EXPECT_STATUS || "检测中";
const EXPECT_NOTE = process.env.EXPECT_NOTE || "A4";
const SHOT_NAME = process.env.SMOKE_SHOT || "smoke.png";

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.url.includes("pitch-scope"));
if (!page) {
  console.error("找不到 pitch-scope 页面");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const consoleLog = [];

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === "Runtime.consoleAPICalled") {
    consoleLog.push({
      type: msg.params.type,
      text: msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ")
    });
    return;
  }
  if (msg.method === "Runtime.exceptionThrown") {
    consoleLog.push({
      type: "exception",
      text: msg.params.exceptionDetails.text
    });
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function valueOf(result) {
  return result && result.result && result.result.result && result.result.result.value;
}

await send("Runtime.enable");
await send("Page.enable");
// 每次冒烟都从默认设置开始，避免上一次手动切换的音频来源影响结果。
await send("Runtime.evaluate", {
  expression: "try { localStorage.removeItem('pitchScope.settings.v1'); } catch (e) {}"
});
await send("Page.navigate", { url: PAGE_URL });
await new Promise((r) => setTimeout(r, 1800));
await send("Emulation.setDeviceMetricsOverride", {
  width: 1400,
  height: 860,
  deviceScaleFactor: 1,
  mobile: false
});

const clicked = await send("Runtime.evaluate", {
  expression: "document.getElementById('btnStart').click(); 'clicked'",
  returnByValue: true
});
console.log("click:", valueOf(clicked));

await new Promise((r) => setTimeout(r, 4200));

const state = await send("Runtime.evaluate", {
  expression: `JSON.stringify({
    status: document.getElementById("statusText").textContent,
    note: document.getElementById("noteLetter").textContent + document.getElementById("noteOctave").textContent,
    cents: document.getElementById("centsValue").textContent,
    caption: document.getElementById("centsCaption").textContent,
    freq: document.getElementById("freqValue").textContent,
    target: document.getElementById("noteFreqValue").textContent,
    level: document.getElementById("levelDb").textContent,
    stats: document.getElementById("chartStats").textContent,
    notice: document.getElementById("noticeText").textContent,
    debug: {
      f0: document.getElementById("dbgF0").textContent,
      aper: document.getElementById("dbgAper").textContent,
      conf: document.getElementById("dbgConf").textContent,
      rate: document.getElementById("dbgRate").textContent
    }
  })`,
  returnByValue: true
});
console.log("state:", valueOf(state));

const shot = await send("Page.captureScreenshot", { format: "png" });
const outDir = path.join(__dirname, "..", "app", "_shots");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, SHOT_NAME), Buffer.from(shot.result.data, "base64"));
console.log("screenshot:", path.join(outDir, SHOT_NAME));

console.log("console:", JSON.stringify(consoleLog, null, 2));
ws.close();

const parsed = JSON.parse(valueOf(state) || "{}");
const ok = parsed.status === EXPECT_STATUS && parsed.note === EXPECT_NOTE;
console.log(`expect: status=${EXPECT_STATUS} note=${EXPECT_NOTE}`);
console.log(ok ? "SMOKE PASS" : "SMOKE FAIL");
process.exit(ok ? 0 : 1);
