# 测试报告 · 音准可视化（Pitch Scope）

日期：2026-11-18
环境：Windows · Node v22.23.2 · Python 3.14.7 · Chrome 156.0.8078.80

---

## 1. 结论

| 层 | 结果 |
| --- | --- |
| 核心算法单元测试 | **45 / 45 通过，0 失败**（2026-11-18 八度族修复后；原 30 项未改动） |
| WAV 回放用例 | **通过**（`fixtures/a4.wav` → A4） |
| JavaScript 语法检查 | `pitch-core.js` / `pitch-worklet.js` / `app.js` 全部通过 |
| 页面静态加载 | **0 控制台错误 / 0 警告 / 0 资源错误 / 0 横向溢出** |
| 桌面布局截图 | 通过（1418×746，单屏不滚动） |
| 窄屏布局截图 | 通过（500×690 视口，全页 1102，无横向溢出） |
| 启动器 | `start.bat` / `start.ps1` 均能定位 Python 并透传参数 |
| 浏览器音频链路（假麦克风） | **通过**：检测中 → A4 / 0 cents / 169 有效点 |
| 浏览器低声压（假麦克风） | **通过**：−52.2 dBFS A4 → 检测中 / A4（默认 −60 dB 门限） |
| 浏览器静音负向（假麦克风） | **通过**：信号不足 → 无音名 / 0 有效点 |
| 系统声音来源 UI | **通过**：切换后设备禁用、提示文案更新（未做真实共享） |
| 真实麦克风端到端 | **未自动验证**，需要用户按第 5 节人工确认 |
| 真实系统声音共享 | **未自动验证**，需要用户按第 5 节人工确认 |

> 说明：自动化环境没有麦克风权限，`getUserMedia` 的成功路径、真实设备枚举、实际体感延迟无法在这里闭环；这些属于人工验收项，已给出可复现步骤与标准音文件。

---

## 2. 核心算法测试

### 2.1 运行方式

```powershell
cd E:\Projects\vocal-note-pitch-tester-ws
node tests\pitch-core.test.js
```

测试只依赖 Node 标准库，不安装任何 npm 包。

### 2.2 结果

```
结果：45 通过，0 失败
```

### 2.3 标准音精度（中位误差）

| 音名 | 目标 Hz | 实测 Hz | 误差 cents |
| --- | --- | --- | --- |
| C2 | 65.406 | 65.406 | 0.00 |
| C3 | 130.813 | 130.813 | 0.00 |
| C4 | 261.626 | 261.626 | 0.00 |
| D4 | 293.665 | 293.665 | 0.00 |
| E4 | 329.628 | 329.627 | 0.00 |
| G4 | 391.995 | 391.995 | 0.00 |
| A4 | 440.000 | 440.000 | 0.00 |
| B4 | 493.883 | 493.884 | 0.00 |
| C5 | 523.251 | 523.251 | 0.00 |
| C6 | 1046.502 | 1046.498 | 0.01 |

- 所有标准音的 P95 误差 **< 5 cents**（测试阈值，全部通过）
- 有效帧比例 **> 95%**（每音 2.2 秒、4096/1024 分帧）
- 音名与八度命中比例 **> 98%**

### 2.4 用例清单

**[1] 音名映射（6 项）**

- A4 = 440 Hz → A4 / 0 cents
- C4 = 261.6256 Hz → C4
- D4 偏高 8 cents 的示例 → `D4 / +8 cents`
- 音分公式 `1200 * log2(f / f0)`：倍频程 1200、同音 0、半音 100
- MIDI ↔ 音名：C4 / C#4 / C6 / C2 / B3 / A#3 / Bb3 / 非法输入
- A4 = 432 Hz：432 → A4；440 → A4 +31.71 cents；C4 → 256.87 Hz

**[2] YIN 精度（5 项）**

- C2–C6 十个标准音检测准确
- P95 < 5 cents
- 音名与八度正确
- D4 在 0 / −5 / +5 cents 偏移下仍稳定判为 D4，音分读数误差 < 1.2 cents

**[3] 边界情况（7 项）**

- 全零静音：所有帧 `f0 = 0`、`valid = false`
- 白噪声（固定种子，2 秒）：有效帧 < 5%，低置信度帧 > 90%
- 振幅 0.004 的低音量正弦：仍能测到基频，RMS 正确落在 −45 dBFS 以下
- 40 Hz / 1400 Hz：超出 65–1250 Hz 范围，全部拒绝
- A3 → A4 滑音（2 秒连续升八度）：有效帧 > 90%，异常帧 < 3%
- ±25 cents / 6 Hz 振动音：音分跨度 > 30 cents（振动被保留，没有被平滑吃掉）
- 基频 + 2–12 次谐波的 G4：中位误差 < 3 cents，所有有效帧都判为 G4，不跳高八度

**[4] 平滑（3 项）**

- 中值滤波抑制单帧 440 → 880 跳变
- 长间隔（500 ms）后重置，不被旧音拖住
- `medianSize=1, tauMs=0` 时直通

**[5] WAV 回放（1 项）**

- `tests/fixtures/a4.wav` 被解析为 16-bit 单声道 → 识别为 A4，音分 < 3

---

## 3. 测试音文件

运行：

```powershell
python tools\make_test_tones.py
```

| 文件 | 频率 / 内容 | 时长 | RMS |
| --- | --- | --- | --- |
| `c4.wav` | 261.626 Hz | 5 s | −13.5 dBFS |
| `d4.wav` | 293.665 Hz | 5 s | −13.5 dBFS |
| `e4.wav` | 329.628 Hz | 5 s | −13.5 dBFS |
| `g4.wav` | 391.995 Hz | 5 s | −13.5 dBFS |
| `a4.wav` | 440.000 Hz | 5 s | −13.5 dBFS |
| `a4_quiet.wav` | 440.000 Hz，低声压 | 5 s | −52.2 dBFS |
| `silence.wav` | 全零 | 2 s | −120.0 dBFS |
| `noise.wav` | 一阶低通噪声 | 3 s | −28.6 dBFS |

格式统一为 48 kHz / 单声道 / 16-bit。

---

## 4. 页面与启动器

### 4.1 静态页面自检

工具：`html` skill 的 `scripts/shot.py`（本机未装 Playwright，自动降级到 Chrome CLI，`engine=chrome_cli`）。

```powershell
python tools\serve.py --no-browser --port 8123
python "<skill-dir>\scripts\shot.py" "http://127.0.0.1:8123/pitch-scope.html" --outdir "app\_shots"
```

结果：

| 项目 | 桌面 | 窄屏 |
| --- | --- | --- |
| 视口 | 1418×746 | 500×690（全页 1102） |
| 控制台错误 | 0 | 0 |
| 控制台警告 | 0 | 0 |
| 资源加载错误 | 0 | 0 |
| 横向溢出 | 无 | 无 |
| canvas | 1 | 1 |
| 截图 | `app/_shots/127_0_0_1_desktop.jpg` | `app/_shots/127_0_0_1_mobile.jpg` |

视觉核对后修正了 5 处：

1. 大号音名读数在 `note-well` 中改为水平居中（原先靠左，右侧大片空白）。
2. 音分条的刻度由密集重复渐变改为 10% 间隔的固定刻度，不再像条形码。
3. 电平门限文字改为跟随门限线的真实位置（−60 dB → 约 14%），不再固定在中间。
4. 目标音标签从 `plotX + 10` 移到 `plotX + 20`，与纵轴音名标签拉开距离；48 个半音压缩时只画自然音级网格，减少糊成一片。
5. **纵轴音名去重判断的符号错误**：原代码 `gy - lastLabelY < 10` 在自下而上遍历时恒为负数，导致 C 以外的 D/E/F/G/A/B 标签全部被跳过，只显示 C2/C3/C4/C5/C6。改为 `Math.abs(gy - lastLabelY) < 9` 后，自然音级标签正常显示（截图可见 C6、B、A5、G、F、E、D、C5…）。

`app/_shots/` 属于过程产物，不随项目交付，也不应删除。

### 4.2 启动器

```powershell
cmd /c "start.bat --help"
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 --help
```

两者都输出 `serve.py` 的帮助信息（`--port` / `--no-browser`），说明 Python 定位与参数透传正常。

> 注意：`start.bat` 最初含中文注释，cmd 在 UTF-8 代码页下解析出错；已改为纯 ASCII 注释并复测通过。

### 4.3 语法检查

```powershell
node --check app\js\pitch-core.js
node --check app\js\pitch-worklet.js
node --check app\js\app.js
node --check tests\browser-smoke.mjs
```

四个文件全部通过。

### 4.4 浏览器端到端冒烟（Chrome 假麦克风）

`tests/browser-smoke.mjs` 通过 Chrome DevTools Protocol 自动点击“开始检测”，读取界面状态并截图。Chrome 用 `a4.wav` 冒充麦克风，因此这条链路不依赖真人、真麦。

> **2026-11-18 更新**：`tests/browser-smoke.mjs` 已不在仓库里（本节记录的是当次运行结果）。
> 现在做同类验证请用 `tools/dev/e2e-check.js` + `tools/dev/compare-e2e.js`（见第 8 节）。
> 另外注意：无头 Chrome 的 `--use-file-for-fake-audio-capture` 实测出的是静音，
> 新工具改为在页面内解码 WAV 并接到 `createMediaStreamSource` 上。

终端 A：

```powershell
python tools\serve.py --no-browser --port 8123
```

终端 B（启动后保持运行）：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new `
  --remote-debugging-port=9229 `
  "--user-data-dir=$env:TEMP\pitchscope-cdp-test" `
  --use-fake-ui-for-media-stream `
  --use-fake-device-for-media-stream `
  "--use-file-for-fake-audio-capture=E:\Projects\vocal-note-pitch-tester-ws\tests\fixtures\a4.wav" `
  --autoplay-policy=no-user-gesture-required `
  http://127.0.0.1:8123/pitch-scope.html
```

终端 C：

```powershell
node tests\browser-smoke.mjs
```

实测输出：

```
click: clicked
state: {"status":"检测中","note":"A4","cents":"0","caption":"在音准附近 · 相对 A4",
        "freq":"440.0 Hz","target":"440.0 Hz","level":"-13 dB",
        "stats":"有效点 169","notice":""}
console: []
SMOKE PASS
```

截图：`app/_shots/smoke.png`（1400×860）。可以看到 A4 大号读数、0 cents、−13 dB 电平、A4 上一条稳定直线、目标音虚线。

**低声压正向用例（−52.2 dBFS）**：把 Chrome 的假麦克风文件换成 `a4_quiet.wav`，再运行同一条命令。默认门限 −60 dB 下实测：

```
state: {"status":"检测中","note":"A4","cents":"0","freq":"440.0 Hz",
        "level":"-52 dB","stats":"有效点 145"}
SMOKE PASS
```

旧默认门限 −45 dB 会把这段音频判成“信号不足”；现在是“检测中 / A4”，说明低声唱歌的门限问题已修复。

**系统声音来源 UI**：在无头 Chrome 里把“音频来源”切到 `system` 后读取 DOM，结果为：

```
source: system
deviceDisabled: true
deviceText: 共享屏幕时选择
deviceLabel: 共享源
note: 点击“开始检测”，选择屏幕或窗口并勾选“分享系统音频”
```

截图：`app/_shots/system-mode.png`。真实的 `getDisplayMedia` 共享需要用户手动选择屏幕并勾选音频，自动化环境无法闭环。

**负向用例（静音）**：把 Chrome 的假麦克风文件换成 `silence.wav`，再运行：

```powershell
$env:EXPECT_STATUS='信号不足'
$env:EXPECT_NOTE='—'
$env:SMOKE_SHOT='silence.png'
node tests\browser-smoke.mjs
```

实测：

```
state: {"status":"信号不足","note":"—","cents":"—","caption":"相对最近音名",
        "freq":"—","target":"—","level":"—","stats":"有效点 0"}
console: []
SMOKE PASS
```

截图：`app/_shots/silence.png`。界面显示“信号不足”，大号读数为 `—`，曲线区提示“信号不足 · 靠近麦克风或提高音量”，有效点 0，没有误报任何音名。

> 该测试验证的是“采集 → AudioWorklet → YIN → 音名映射 → Canvas”整条代码链路；**不能替代真实麦克风与权限弹窗的人工验收**。

---

## 5. 人工验收清单（需要麦克风 / 扬声器）

自动化环境无法替代这一步。按顺序做，预计 5 分钟。

| # | 步骤 | 通过标准 | 状态 |
| --- | --- | --- | --- |
| 1 | 双击 `start.bat`，浏览器打开页面，点“开始检测”，允许麦克风 | 状态从“未启动”变为“检测中/信号不足” | 待人工 |
| 2 | 循环播放 `tests/fixtures/c4.wav`，扬声器靠近麦克风 | 稳定显示 C4；曲线在 C4 附近 | 待人工 |
| 3 | 依次播放 `d4/e4/g4/a4.wav` | 分别显示 D4 / E4 / G4 / A4 | 待人工 |
| 4 | 播放 `a4_quiet.wav`（−52.2 dBFS） | 默认 −60 dB 门限下仍显示 A4；否则记录电平并调门限到 −65 / −70 | 待人工 |
| 5 | 播放 `silence.wav` 或停止播放 | 显示“信号不足”，不误报音名，曲线断开 | 待人工 |
| 6 | 播放 `noise.wav` | 显示“低置信度”或“信号不足”，无稳定音名 | 待人工 |
| 7 | 唱一个稳定单音，故意偏低 / 偏高 | 曲线整体下移 / 上移；音分符号正确 | 待人工 |
| 8 | 音频来源切“系统声音”，共享整个屏幕并勾选“分享系统音频”，播放 `a4.wav` | 显示 A4；停止共享后回到“已停止” | 待人工 |
| 9 | 设置 A4 = 442 Hz | 顶部 chip 变 442.0 Hz；A4 目标频率 442.0 Hz | 待人工 |
| 10 | 全文检查界面 | 无“得分 / 等级 / 命中率 / 报告 / 唱功评价”字样 | 待人工（静态截图已核对） |

---

## 6. 未覆盖 / 已知缺口

1. **麦克风授权成功路径**：自动化环境没有真实设备与用户手势，无法验证浏览器权限弹窗后的完整链路。
2. **设备枚举与热插拔**：代码有 `enumerateDevices`、`devicechange`、`track.ended` 监听，但没有真实设备可测。
3. **实际延迟**：界面显示约 82 ms 是按 `窗口/2 + 跳帧 + 18 ms` 的估算；未用示波器/双机录音测量。
4. **真实人声**：测试音是理想正弦与合成谐波；气声、颤音、方言元音的实际表现需要用户试唱。
5. **蓝牙耳机 / 虚拟声卡**：未测；这类设备的缓冲会显著增加延迟。
6. **移动端**：只在 500 px 宽度做了布局截图，未在真实手机上测 AudioWorklet 与麦克风权限。
7. **真实系统声音共享**：无头 Chrome 无法完成“选择整个屏幕 + 勾选分享音频”的交互，只验证了来源切换 UI 与错误文案；需要真实浏览器人工验收。
8. **受保护 / 独占音频**：DRM 视频、独占模式应用、部分游戏可能不在系统回环里，未做覆盖测试。
9. **旧设置迁移**：逻辑上只在 `version !== 2 && gateDb === -45` 时迁移；未用真实旧 localStorage 做浏览器级回归。

---

## 7. 复现命令汇总

```powershell
cd E:\Projects\vocal-note-pitch-tester-ws

# 1. 算法测试
node tests\pitch-core.test.js

# 2. 重新生成测试音（可选）
python tools\make_test_tones.py

# 3. 起服务
python tools\serve.py

# 4. 打开页面
# http://127.0.0.1:8123/pitch-scope.html
```

---

## 8. 八度族跳变修复验证（2026-11-18 追加）

问题与机制见 [`docs/ISSUE_OCTAVE_JUMP.md`](ISSUE_OCTAVE_JUMP.md)。这一节只记验证数据。

### 8.1 单元测试

```
结果：45 通过，0 失败
```

原有 30 项全部保留且未改动，C2–C6 音分误差仍为 0.00–0.01（未劣化）。新增 15 项：

| 用例 | 断言 |
| --- | --- |
| 真实周期凹陷变浅、2T 更深 | 取 τ=90（0.223）而不是 τ=181（0.140） |
| 真实次谐波（2T 远深于 T） | 保留 2T，不被误改高 |
| 干净纯音的 kT 凹陷 | 取最短周期，不因数值误差落到 3T/5T |
| 兜底分支贴近搜索下限 | 判为无效，不再输出 63.49 Hz |
| 周期倍增合成信号 | 正确读成低八度 |
| 八度跳变 3 帧确认 | 2 帧毛刺被挡住；第 3 帧（≈64 ms）接受 |
| 非八度大跳变（+7 半音） | 2 帧内跟上，不被八度规则拖慢 |
| 单帧低置信度 | 状态保持「检测中」、读数保持、不新增曲线点 |
| 低置信度持续 >150 ms | 清空读数并切到「低置信度」 |
| 状态机 2 帧毛刺 | 曲线上不出现 G5 |
| 真实八度跳唱 | 100 ms 内画出新音 |
| 设置变化 | 音域收窄后 C2 判为超出范围 |
| 现场录音回归 | `docs/evidence/…-48k-mono.wav` 上八度族误锁为 0 |

### 8.2 逐帧复算（同一段 20.75 s 现场录音，页面默认搜索范围 64.1–1067.4 Hz）

| 指标 | 修复前 `12b8bd7` | 修复后 |
| --- | --- | --- |
| 曲线点（aper ≤ 0.25） | 483 | 483 |
| 八度族跳变帧 | 3（−14.7 / −12.3 / −11.8 半音） | 0 |
| 大跳变帧（≥5 半音） | 3 | 0 |
| 曲线断段 | 8 | 8 |
| 搜索下限读数帧 | 0 | 0 |

### 8.3 浏览器端到端（无头 Chrome + 虚拟麦克风，真实页面）

| 指标 | 修复前页面 | 修复后页面 |
| --- | --- | --- |
| 采集帧数（22 s） | 1020 | 1031 |
| 曲线点 / 断段 | 501 / 9 | 501 / 9 |
| 八度族跳变帧 | 3（3.285 s、7.595 s、18.219 s） | 0 |
| 页面异常 / 控制台错误 | 0 | 0 |
| 与 Node 复算逐帧差 | — | 对齐 483 帧，平均 / 最大均为 0.00 音分 |

### 8.4 状态机层面的改善（同一段录音逐帧回放）

| 指标 | 修复前状态机 | 修复后状态机 |
| --- | --- | --- |
| 非检测状态切换 | 27 次 | 9 次 |
| 累计「读数为空」时长 | 8085 ms | 5952 ms |
| 读数保持帧 | 0 | 107 |

### 8.5 性能

969 帧、48 kHz：修复前 0.614 ms/帧，修复后 0.588 ms/帧；跳帧预算 21.3 ms，无退化。

### 8.6 仍未覆盖

- 现场录音里「气口底噪被读成 A2/A3」的旧问题仍在（与本次八度族修复无关，见
  `ISSUE_OCTAVE_JUMP.md` §11.5）；需要时按 §9.2 的方式在连续 128 采样块上做前置滤波。
- 真实麦克风 / 真实系统声音共享仍属人工验收项。

### 8.7 复现

```powershell
node tools\dev\devserver.js 8199
git show 12b8bd7:app\js\pitch-core.js > .tmp\pitch-core-baseline.js
node tools\analyze-audio.js docs\evidence\2026-11-18-mic-recording-48k-mono.wav --core .tmp\pitch-core-baseline.js --label 修复前 --tracker old
node tools\analyze-audio.js docs\evidence\2026-11-18-mic-recording-48k-mono.wav --label 修复后 --tracker new
node tools\dev\e2e-check.js --out .tmp\e2e-new.json --label 修复后 --seconds 22 --shot docs\img\fix-after.png
node tools\dev\compare-e2e.js
node tests\pitch-core.test.js
```
