# dsh-audio-visualizer（音频律动）

[English](README.md) | **简体中文**

给 DeepSeek Harness 的**系统音频驱动界面律动**插件（支持 **dsh web** 与 **DSH Desktop**）。

- **频谱芯片**：一个可拖动的 118×24 悬浮小条，绘制 48 段彩虹频谱，实时跟随系统声音输出。
- **全窗光晕**：整个窗口边缘有低音驱动的内发光（10–56px 扩散，色相随低频变化）。
- **纯内存 FFT**：音频只用 Web Audio `AnalyserNode` 在内存里分析，不落盘、不上传、不录制。
- 点击芯片开关；位置会被记住。

## 工作原理

`getDisplayMedia({ audio })` → 丢弃占位视频轨 → `AnalyserNode`（fftSize 512、smoothing 0.5）→ FFT 分箱的对数映射成 48 段 → 动态峰值增益 → canvas 绘制。

在 **DSH Desktop** 上，Electron 主进程会为每个渲染会话直接授予 `audio: 'loopback'`，所以律动**随 app 启动自动开启**（无弹窗、零点击）。这需要一次性补丁（见下）。

## 安装

已发布到 npm：[`dsh-audio-visualizer`](https://www.npmjs.com/package/dsh-audio-visualizer)（也可从 Git 安装：`git+https://github.com/caesarjue/dsh-audio-visualizer`）。

### dsh web

```sh
dsh plugin --profile web add dsh-audio-visualizer
```

然后点击芯片，在弹窗里选「**整个屏幕**」并勾选「**分享系统音频**」。浏览器安全模型要求每次手动确认；仅支持 macOS Chrome/Chromium 141+。

### DSH Desktop

```sh
dsh plugin --profile desktop add dsh-audio-visualizer
```

**另需一次性补丁**——DSH Desktop 的 Electron 主进程需要以系统音频回环来应答 `getDisplayMedia`。补丁脚本随仓库提供（`patch/`）：

```sh
./patch/install-patch.sh   # 自动：备份 app → 打补丁 main.js → 重签名 → 引导 macOS 授权
```

细节与回滚见 `patch/README.md`。打完补丁后，律动随 app 启动自动开启，零交互。

## 环境要求

- macOS 14.2+（系统音频回环，基于 Core Audio taps）；macOS 权限：**屏幕录制** + **音频捕获**（系统设置里打开后需重启 app 一次）
- Web 版需要 Chrome/Chromium 141+
- DSH Desktop 2.0.5+（Electron 43）实测可用；dsh web 在 0.1.5 上实测可用

## 文件

- `package.json` / `cordis.patch.yml` / `lib/` —— 插件本体（已声明 `dsh.bundle` manifest）
- `patch/` —— 可选的 DSH Desktop 主进程补丁（安装脚本 + 补丁文件 + 说明）

## 许可

MIT
