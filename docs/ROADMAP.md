# 后续迭代路线图 · Pitch Scope

日期：2026-11-18

> 本文回答三个问题：**现在这套浏览器原型接下来怎么变成 Windows 客户端；安卓端什么时候做、用什么做；有哪些开源项目/算法/采集方案值得借鉴，哪些不能碰。**
>
> 产品边界不变：只做单声部音准可视化，不做评分、等级、命中率、练习报告、唱功评价、复音/和弦、全频段频谱仪。

---

## 1. 结论摘要

1. **Windows 先做，且先用 Electron 套壳。** 现有 `app/` 的 HTML/JS/Canvas 可以 100% 复用；系统声音用 Electron 官方的 `setDisplayMediaRequestHandler` + `audio: 'loopback'`，不再弹“共享整个屏幕 + 勾选分享音频”的选择器。这是当前改造成本最低、风险最小的路径。
2. **音高核心暂时不换。** 现有 YIN 在 C2–C6 标准音上中位误差 0.00 cents，43/43 单测通过；真正影响体验的是低声门限、系统音频采集和状态提示，不是算法精度。pYIN / CREPE 放到“可选高精度模式”或离线基准，不作为默认运行时。
3. **安卓端现在只做技术储备，不写代码。** 等 Windows 客户端稳定并收到明确指令后，先做 3 天技术选型 Spike（Tauri 2 / Capacitor / Flutter），再决定。安卓系统音频受 `AudioPlaybackCapture` + `MediaProjection` 限制，只能作为“实验性功能”，不能承诺所有游戏/视频都能采。
4. **开源依赖要避坑。** `pitchfinder`、TarsosDSP、aubio 都是 GPL；`pitchy`、`sevagh/pitch-detection`、CREPE 是 MIT。若本项目未来要闭源分发，不要把 GPL 库直接链进安装包；若整体开源并采用 GPL 兼容许可证，则另说。
5. **项目已纳入 Git。** 从本次提交开始，后续每个阶段用独立分支/提交推进；`_shots/`、`__pycache__` 等过程产物不进仓库。

---

## 2. 调研范围与方法

只调研与以下三条链路直接相关的内容：

- **音高**：单声部、实时、C2–C6、可接受 100–150 ms 延迟的基频估计。
- **采集**：Windows 麦克风 / Windows 系统回环 / Android 麦克风 / Android 系统播放捕获。
- **壳与分发**：能把现有 Web UI 变成 Windows 客户端，并保留未来安卓可能性的方案。

评分、教学、曲库、stem separation、社区排行等方向不在调研范围内；提到相关产品时只作为交互参考，不纳入功能规划。

---

## 3. 现有开源项目 / 产品盘点

| 项目 | 平台 / 形态 | 技术 / 算法 | 许可证 | 可借鉴 | 不照搬 |
| --- | --- | --- | --- | --- | --- |
| **VocalScope（声域）** | Android | Kotlin + Jetpack Compose + TarsosDSP YIN；44.1 kHz / 2048 缓冲；置信度 > 0.85、RMS > 0.015、65–1100 Hz；中值滤波 + 跳变确认 | 页面未标注 | 移动端“大号音名 + 键盘高亮 + 防跳变”的信息层级；AudioRecord 原始 PCM 链路 | 它做“最低音/最高音”音域统计，我们的边界明确不做统计与结论 |
| **Tony** | Windows / Linux / macOS | Sonic Visualiser 家族；离线旋律/音符转写，面向独唱录音；可人工修正、导出 CSV | 开源（具体许可证以仓库为准） | “音高轨迹 + 音符层 + 可修正”的长期分析视图；独唱场景的定位 | 它是离线转写工具，不是实时练习仪表；不把音符切分/导出塞进当前版本 |
| **VocalPitchMonitor** | iOS | 闭源商业 App；C2–B7 时间–音高图、自动滚动、Hold | 闭源 | 纵轴音名、横轴时间的“示波器式”曲线；Hold 冻结画面 | 不复刻它的付费/闭源实现；不做音域统计 |
| **OnKey** | macOS | MIT；跟唱 Spotify / Apple Music / YouTube，首次给歌词、随后学习歌手旋律 | MIT | “播放器/视频 + 跟唱”是真实使用场景；系统音频值得做 | 它含歌词、教学、歌曲学习；我们只做音高可视化 |
| **Mercury Pitch** | 浏览器 | 作者称开源、端侧实时音高分析；含 karaoke、stem separation、评分、排行榜 | 未核实（以仓库为准） | 端侧 Web Audio 实时分析在浏览器里可行；低延迟、隐私友好 | 评分、排行榜、stem separation、社区挑战全部与我们的产品边界冲突 |
| **pitchfinder** | JS / Node | YIN、McLeod、AMDF、Dynamic Wavelet | **GPL-3.0** | 快速原型、算法对照 | 不直接链进闭源安装包；GPL 传染 |
| **pitchy** | JS | McLeod Pitch Method（MPM），纯 JS，实时 tuner 取向 | **MIT** | 轻量 MIT 备选；可作为 YIN 的第二意见 | 最后发布约 3 年前，维护活跃度低；不把它当唯一核心 |
| **sevagh/pitch-detection** | C++ | FFT 自相关 O(NlogN)；YIN、MPM、pYIN、PMPM；228 个单测 | **MIT** | 原生高性能核心；pYIN 实现参考；适合桌面/移动原生 | README 明确“需要 Linux / cmake / gcc，不官方支持其他平台”；Windows 需自行验证 MSVC 构建 |
| **TarsosDSP** | Java / Android | YIN、FastYIN、MPM、AMDF；Android 音频 I/O | **GPL-3.0** | Android 端 AudioRecord + PitchProcessor 的成熟范式 | GPL；不用于闭源 APK 的直接链接 |
| **aubio** | C / Python | YIN、pYIN、onset、beat、MFCC 等 | **GPL-3.0+** | 成熟的离线/命令行基准工具 | 官方明确“不是 MIT 或 BSD”；不用于闭源分发 |
| **CREPE** | Python / TensorFlow | 时域波形输入的 CNN 基频估计；论文称优于 pYIN/SWIPE；16 kHz 输入；GPU 更快 | **MIT** | 离线高精度基准；可做“高精度分析模式” | 模型重、依赖 TensorFlow；不作为实时默认路径 |

### 3.1 从这些项目里真正该学的

- **VocalScope**：移动端一屏只放“当前音名 + 曲线/键盘 + 开始按钮”，信息密度低、看一眼就懂；它的 RMS + 置信度 + 频率范围 + 跳变确认四道过滤，和我们的状态机思路一致。
- **VocalPitchMonitor**：时间–音高图的纵横轴比例、Hold 冻结、自动滚动，是“练习时看一眼”的好交互。
- **Tony**：独唱场景下“轨迹 + 音符层”的表达，适合未来做“回看刚才唱了什么”，但当前版本不做录音/回放。
- **OnKey**：证明了“播放器/视频 + 跟唱”是真实需求，Windows 端值得把系统回环做成默认能力。
- **Mercury Pitch**：证明了浏览器端侧实时音高可行；但它的评分/排行榜/伴奏分离是我们明确不做的方向。

### 3.2 不该学的

- 把音域极值、平均偏差、命中率做成“结果页”。
- 把频谱图、瀑布图当主界面。
- 用排行榜/社区挑战制造练习压力。
- 把“AI 评分/唱功诊断”包装成核心卖点。

---

## 4. 音高算法：现在够用，下一步只做“可选增强”

### 4.1 现状

- YIN：4096 样本窗口（48 kHz 约 85.3 ms），hop 1024（约 21.3 ms）；2 倍降采样粗估 + 原始采样率局部细化 + 抛物线插值。
- 标准音 C2–C6 中位误差 0.00 cents（C6 0.01），P95 < 5 cents；无声/噪声不误报；滑音异常帧 < 3%；谐波不跳八度。
- 置信度用 `1 - aperiodicity`，默认门槛 75%；低置信度断线，不硬画音名。

### 4.2 结论

**默认运行时继续用 YIN。** 对单声部人声，YIN 的精度和延迟已经够用；换 pYIN/CREPE 的收益主要出现在噪声、气声、弱音、快速滑音等边缘场景，成本却是 CPU、模型体积和调参复杂度。

### 4.3 可选增强（按优先级）

| 优先级 | 方案 | 收益 | 成本 | 何时做 |
| --- | --- | --- | --- | --- |
| P1 | 采集前置：60 Hz 高通 + 1.2 kHz 低通、按噪声底自适应门限 | 低声/噪声场景更稳；减少“信号不足”误判 | 小，纯 JS | Windows MVP 之后 |
| P1 | 置信度校准：把 aperiodicity 分档为“确定 / 不确定 / 拒绝”，不确定区间显示空心点或灰色段 | 曲线更诚实；不把边缘帧画成确定音高 | 小 | 与 P1 一起 |
| P2 | pYIN 后处理（概率阈值分布 + HMM 平滑） | 减少八度跳变、弱音抖动 | 中；可参考 MIT 的 `sevagh/pitch-detection` | 有真实用户反馈后 |
| P2 | MPM 第二意见（`pitchy`，MIT） | 对低频/弱音提供交叉校验；两算法一致才标“确定” | 小；但库 3 年未更新 | 作为可选实验 |
| P3 | CREPE 离线基准 / 高精度模式 | 论文级精度；可作为测试 oracle | 大；TensorFlow + 模型 | 只在桌面端离线分析模式考虑 |

### 4.4 延迟预算

当前估算：`窗口/2 + hop + 18 ms`，48 kHz 下约 82 ms。Windows Electron 回环会多一层系统缓冲；目标仍是 **≤150 ms**。落地时用“播放标准音 + 界面时间戳”测端到端延迟，不靠公式拍脑袋。

---

## 5. 系统音频采集：Windows 用 Electron 回环，Android 后置

### 5.1 四条候选路径

| 路径 | 平台 | 工作方式 | 优点 | 限制 |
| --- | --- | --- | --- | --- |
| **浏览器 `getDisplayMedia`** | Chrome / Edge 桌面 | 共享整个屏幕 + 勾选“分享系统音频” | 当前已实现；零安装；跨平台浏览器可用 | 必须共享屏幕；有共享指示；用户要手动勾选；Firefox 可能没有系统音频 |
| **Electron `audio: 'loopback'`** | Windows 10+ / macOS 12.3+ / Linux PulseAudio | 主进程 `setDisplayMediaRequestHandler` 直接返回 `{ video: sources[0], audio: 'loopback' }` | 官方支持；无需第三方驱动；不再弹共享选择器；现有 `getDisplayMedia` 调用可原样复用 | 仅桌面；Electron 体积大；只能采默认输出设备（除非自己做设备选择） |
| **WASAPI loopback** | Windows | 原生 C++/Rust 打开渲染端点的环回流 | 最低层、最可控；可做设备选择/低延迟 | 需要原生开发；Electron 里要写 native addon；Tauri 里要写 Rust 插件 |
| **Android `AudioPlaybackCapture`** | Android 10+ | `MediaProjection` 授权 + `AudioRecord` + `AudioPlaybackCaptureConfiguration` | 系统级、无驱动依赖 | 需 `RECORD_AUDIO`；需用户同意屏幕捕获；采集与被采应用必须同一用户配置；被采应用必须允许 capture（`ALLOW_CAPTURE_BY_ALL`）；DRM/受保护内容通常不可采 |

### 5.2 结论

- **Windows 现在**：Electron 官方 loopback。它把“系统声音”从“共享整个屏幕 + 勾选音频”变成“点开始就能采”，是体验上最大的一步。
- **Android 以后**：麦克风优先；系统音频作为“实验性”入口，明确提示“部分应用/DRM 内容无法捕获”。不要把它做成默认卖点。
- **不建议**在 Windows 上继续依赖浏览器共享屏幕作为最终形态；它适合原型和临时验证，不适合作为客户端的主交互。

---

## 6. 跨端壳：Windows 选 Electron，安卓留到指令后再说

| 方案 | 覆盖平台 | 前端复用 | 原生能力 | 体积/依赖 | 适合本项目吗 |
| --- | --- | --- | --- | --- | --- |
| **Electron** | Windows / macOS / Linux | 现有 HTML/JS 100% 复用 | Node + Chromium；官方 loopback | 安装包大（打包 Chromium）；内存高 | **Windows 现阶段最合适**；没有安卓 |
| **Tauri 2** | Windows / macOS / Linux / Android / iOS | 现有 HTML/JS 可复用 | Rust 后端；Kotlin/Swift 插件；系统 WebView | 体积极小；需要 Rust + Android Studio/NDK | **长期一套壳的首选候选**；Windows 回环需自建 WASAPI 插件；需 PoC |
| **Capacitor** | Android / iOS / Web | 现有 HTML/JS 可复用 | JS + 原生插件；Android 生态成熟 | 比 Electron 轻；Windows 无官方支持 | 如果只想“最快上安卓”，配合 Electron 做 Windows，是低摩擦方案 |
| **Flutter** | Windows / Android / iOS | 不能直接复用 HTML/JS | Dart + 原生插件；UI 性能好 | 需要重写 UI 与核心 | 如果愿意重做界面、追求移动端手感，才考虑 |

### 6.1 建议

- **Windows 阶段（现在）**：Electron。理由：现有代码零迁移、官方 loopback、Node 工具链用户已具备、打包/签名/更新生态成熟。
- **安卓阶段（待指令）**：先做 3 天 Spike，按同一组指标打分：
  1. 麦克风端到端延迟（C4 标准音，目标 ≤150 ms）；
  2. Android WebView 下 AudioWorklet 是否可用；不可用则原生 PCM → 事件的改造量；
  3. `MediaProjection` / `AudioPlaybackCapture` 插件工作量；
  4. APK 体积与冷启动；
  5. 现有 UI 复用比例；
  6. 开发者学习成本（Rust/Kotlin/Dart）。
- **默认倾向**：如果“一套代码两端”最重要且愿意学 Rust/Kotlin，选 **Tauri 2**；如果只想最快出安卓、保持 JS，选 **Capacitor**；如果移动端 UI 手感优先、接受重写，选 **Flutter**。不要在 Windows MVP 之前锁死安卓技术栈。

---

## 7. 分阶段迭代计划

> 时间是按“业余时间、单人开发”的粗略估计，不是承诺工期；每阶段结束都有可验收产物。

### P0 · 浏览器原型（已完成）

- Web Audio + AudioWorklet + Canvas 2D；YIN + 十二平均律映射；目标音参考线；状态机；设置持久化。
- 43/43 算法单测；A4 假麦克风冒烟；静音负向；低声 A4（−52.2 dBFS）通过；系统声音来源 UI 通过。
- 产物：`app/`、`tests/`、`tools/`、`README.md`、`docs/IMPLEMENTATION_PLAN.md`、`docs/TEST_REPORT.md`。

### P1 · Windows 桌面 MVP（下一阶段，约 5–8 个工作日）

**目标**：双击安装/打开就能用；麦克风和系统声音都不再依赖浏览器共享选择器。

- 新建 `desktop/`：Electron 主进程 + preload + 打包配置；窗口加载 `app/pitch-scope.html`。
- `session.setDisplayMediaRequestHandler` 返回 `audio: 'loopback'`；保留现有 `getDisplayMedia` 调用，系统来源无需改 UI。
- 麦克风权限：`setPermissionRequestHandler` 只放行 `media` / `display-capture`；拒绝其它权限。
- 窗口：默认 1280×820、最小 960×640、记住窗口位置、单实例；可选“始终置顶”小开关。
- 打包：`electron-builder` 产出 NSIS 安装包 + 免安装 zip；应用图标、版本号、关于页。
- 启动：去掉 `serve.py` 依赖；桌面版直接 `loadFile`，不再需要本地 HTTP（麦克风/Worklet 在 Electron 下可用；若 `file://` 仍拦截，则用自定义 `app://` 协议，而不是开 HTTP 服务）。
- 验收：见第 8 节。

**不在 P1 做**：自动更新、代码签名、崩溃上报、多语言、安卓。

### P1.5 · Windows 发布打磨（约 3–5 个工作日）

- 代码签名（有证书再做；没有证书时在 README 说明 SmartScreen 提示）。
- 本地崩溃日志（只写本地，不上传）；“关于/隐私”页。
- 发布清单：版本号、安装包校验值、卸载残留、升级覆盖安装。
- README 增加“Windows 客户端”章节；保留浏览器版作为开发/调试入口。

### P2 · 音准体验增强（约 2–3 周，按真实反馈排优先级）

- 门限预设：安静房间 / 普通房间 / 低声练习；仍允许手动 −70…−20。
- 采集前置滤波 + 置信度分档（确定/不确定/拒绝）；低置信度显示空心点或灰段。
- 可选 pYIN 后处理或 MPM 第二意见；默认关闭，设置在“实验性”里。
- 曲线交互：暂停/冻结、时间窗缩放、目标音快捷键、始终置顶迷你模式。
- 设备热插拔与默认设备切换；系统回环输出设备选择（如果 Electron loopback 支持枚举）。
- 仍然不做：评分、报告、命中率、平均偏差、排行榜。

### P3 · Android（仅在用户明确下令后启动，约 3–6 周）

**Gate 0：3 天 Spike**

- 用同一份 `app/` 前端分别跑 Tauri 2 / Capacitor / Flutter 的最小 Demo：
  - 麦克风采集 → 音高 → 曲线；
  - 切后台/回前台；
  - 权限拒绝/恢复；
  - 测量延迟与 APK 体积。
- 产出选型报告，确认后再进入正式开发。

**MVP 范围**

- 麦克风单声道、C2–C6、100–150 ms、音名/音分/曲线/目标线/状态机。
- 移动端布局：大号音名 + 曲线占主屏；设置折叠；保持“看一眼就懂”。
- 系统音频：实验性入口，`MediaProjection` + `AudioPlaybackCapture`；明确提示限制，不保证所有应用可采。
- 不做评分/报告/排行榜；不做复音。

### P4 · 分发与维护（持续）

- CI：Node 单测 + 语法检查 + 构建安装包；Tag 触发 Release。
- 版本策略：`0.x` 阶段快速迭代；Windows 签名后再考虑自动更新。
- 文档：`README`、`docs/TEST_REPORT`、`docs/ROADMAP` 随版本更新。
- 许可证：见第 10 节待决策。

---

## 8. Windows MVP 验收清单

| # | 场景 | 通过标准 |
| --- | --- | --- |
| 1 | 安装/免安装启动 | 双击可开；无控制台窗口；窗口尺寸/位置合理 |
| 2 | 麦克风 C4/D4/E4/G4/A4 | 稳定显示对应音名与八度；曲线落在音名附近 |
| 3 | 低声 A4（−52.2 dBFS 或真人低声） | 默认 −60 dB 门限下可检测；必要时可调到 −70 |
| 4 | 无声 / 噪声 | 不误报音名；曲线断开；状态为“信号不足/低置信度” |
| 5 | 系统声音（视频/游戏） | 点“开始检测”后直接采到回环，无屏幕共享选择器；曲线随音频变化 |
| 6 | 停止/切换来源 | 停止后释放音频；切回麦克风正常；无残留共享 |
| 7 | A4 = 442 Hz | 音名映射与曲线刻度同步变化 |
| 8 | 产品边界 | 界面无评分/等级/命中率/报告/唱功评价；无全频段频谱主视图 |
| 9 | 延迟 | 端到端 ≤150 ms（实测，不只看估算） |
| 10 | 稳定性 | 连续运行 30 分钟不崩；设备热插拔可恢复 |

---

## 9. 架构演进与目录

```text
vocal-note-pitch-tester-ws/
├── app/                      # 共享前端：HTML / CSS / JS / Canvas
│   ├── pitch-scope.html
│   ├── styles.css
│   └── js/
│       ├── pitch-core.js     # 纯计算：音名映射 + YIN + 平滑
│       ├── pitch-worklet.js  # AudioWorklet：采集/组帧/分析
│       └── app.js            # 状态机 / 曲线 / 设置 / 来源切换
├── desktop/                  # P1：Windows Electron 壳
│   ├── main.js               # BrowserWindow / 权限 / loopback handler
│   ├── preload.js            # 最小暴露面
│   ├── package.json
│   └── build/                # 图标、安装器资源
├── tests/                    # Node 单测 + 浏览器冒烟 + fixtures
├── tools/                    # serve.py / make_test_tones.py
├── docs/                     # 计划 / 测试 / 路线图
├── start.bat / start.ps1     # 浏览器版启动（保留）
└── README.md
```

**未来 Android 目录**（P3 再建，不提前占位）：

```text
android/                      # Tauri 2 或 Capacitor 工程
  src-tauri/ 或 android/      # Rust/Kotlin 或原生工程
  plugins/audio-capture/      # 麦克风 + MediaProjection 插件
```

**解耦原则不变**：`pitch-core.js` 只依赖 `Float32Array` 和采样率；壳只负责“拿到音频流/帧”，不把音高算法复制到 Electron 主进程或 Android 原生层。若 Android WebView 不支持 AudioWorklet，再考虑把 YIN 移到 Kotlin/Rust，通过事件把 `{f0, confidence, rms, db, t}` 发给 UI；映射与曲线仍留在前端。

---

## 10. 风险、许可证与待决策

### 10.1 风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| Electron loopback 只能采默认输出设备 | 用户有多个声卡/耳机时采错设备 | P1 先采默认；P2 研究设备枚举或 WASAPI 插件 |
| 系统回环包含多个声源 | YIN 只能跟最强单音，结果可能跳 | 明确“单声部”边界；提示用户关闭其它声音 |
| 低声/气声置信度低 | 曲线断开，用户以为“没检测到” | 置信度分档 + 状态文案 + 门限预设；不硬报音名 |
| 蓝牙耳机/虚拟声卡缓冲 | 延迟超过 150 ms | 界面标注估算；README 建议有线；P2 实测 |
| 安卓 MediaProjection 限制 | 部分游戏/DRM 无法采 | 作为实验性功能；权限与限制写进 UI 和文档 |
| Tauri 2 Windows 回环未验证 | 若选 Tauri，系统音频要补 Rust/WASAPI 插件 | P3 Spike 先验证；不行就 Electron 继续做 Windows |
| 许可证传染 | GPL 依赖导致整个客户端必须 GPL | 默认只用 MIT/BSD/Apache 依赖；GPL 库只做离线基准或独立进程调用，并咨询法律意见 |

### 10.2 许可证结论

- **可直接用于闭源分发的候选**：`pitchy`（MIT）、`sevagh/pitch-detection`（MIT）、CREPE（MIT，但模型重）。
- **GPL，谨慎**：`pitchfinder`（GPL-3.0）、TarsosDSP（GPL-3.0）、aubio（GPL-3.0+）。
- **本项目自身**：当前没有 LICENSE。是否开源、用 MIT 还是 GPL，需要用户决定；在没有决定前，不把 GPL 代码直接链进安装包。

### 10.3 待用户确认

1. Windows 壳是否按建议用 **Electron**（而不是直接上 Tauri 2）？
2. 本项目是否开源？若开源，许可证选 **MIT** 还是其它？
3. 系统声音是否只采 **默认输出设备**，还是一开始就要做“选择输出设备”？
4. 安卓端等 Windows 稳定后再启动，是否同意“先 3 天 Spike 再定栈”的流程？

---

## 11. 参考链接

**音高算法 / 库**

- pitchfinder（npm，GPL-3.0）：https://www.npmjs.com/package/pitchfinder
- pitchy（npm，MIT）：https://www.npmjs.com/package/pitchy
- sevagh/pitch-detection（C++，MIT）：https://github.com/sevagh/pitch-detection
- TarsosDSP（GPL-3.0）：https://mvnrepository.com/artifact/be.tarsos.dsp/jvm/2.5
- TarsosDSP Readme：https://0110.be/releases/TarsosDSP/TarsosDSP-2.3/TarsosDSP-2.3-Readme.html
- aubio（GPL-3.0+，官方明确非 MIT/BSD）：https://aubio.org/manual/0.4.4/index.html
- CREPE（MIT）：https://pypi.org/project/crepe/

**现有应用 / 产品参考**

- VocalScope（Android，TarsosDSP YIN）：https://tianxing-ovo.github.io/VocalScope/
- Tony（桌面离线旋律转写）：https://www.sonicvisualiser.org/tony/
- VocalPitchMonitor（iOS 时间–音高图）：https://tadaoyamaoka.github.io/home/VocalPitchMonitor/
- OnKey（macOS，MIT，跟唱）：https://alternativeto.net/software/onpitch/
- Mercury Pitch（浏览器端侧练习室）：https://www.producthunt.com/p/mercury-pitch/mercury-pitch

**壳 / 采集**

- Tauri 2 介绍：https://v2.tauri.app/start/
- Tauri 2 环境依赖（含 Android Studio/NDK）：https://v2.tauri.app/start/prerequisites/
- Tauri 2 移动开发：https://v2.tauri.app/develop/
- Electron desktopCapturer（`audio: 'loopback'` 官方示例）：https://www.electronjs.org/docs/latest/api/desktop-capturer
- WASAPI 环回录制（Microsoft）：https://learn.microsoft.com/zh-cn/windows/win32/coreaudio/loopback-recording
- Android 录制音频播放内容（AudioPlaybackCapture）：https://developer.android.com/media/platform/av-capture?hl=zh-cn
