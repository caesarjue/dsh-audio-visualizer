# DSH Desktop main-process patch（可选组件）

这个目录里的补丁是**可选的**，只服务于 **DSH Desktop** 用户。

## 为什么需要它

dsh web 版里，浏览器安全模型要求用户**每次**在分享弹窗里手动选择屏幕并勾选「分享系统音频」。

DSH Desktop 是 Electron 应用，可以让**主进程**应答 `getDisplayMedia` 请求（直接授予 `audio: 'loopback'` 系统音频回环），从而做到**零交互、随 app 启动自动开启**。

DSH Desktop 2.0.5 的官方主进程**没有**这个处理（渲染端调用 `getDisplayMedia` 会直接被拒：`NotSupportedError`）。所以需要打一个**很小的补丁**：

1. 启用 `MacCatapLoopbackAudioForScreenShare`（Chromium 的 macOS 系统音频回环能力）；
2. 对**每个渲染会话**注册 `setDisplayMediaRequestHandler`，授予「屏幕源 + loopback 音频」；
3. 所有错误路径静默处理（该 app 有 fail-loud 机制，未处理异常会直接退出）。

补丁**不改动插件功能**，只补上「主进程应答」这一层；总共约 40 行，改动点见 `main.js.patch`。

## 怎么打

```sh
./install-patch.sh
```

脚本会（每步都会先打印再执行）：

1. 找到 `/Applications/DSH Desktop.app`（可用环境变量 `DSH_APP` 覆盖）；
2. **完整备份**到 `~/DSH-Desktop-<版本>-backup.app`；
3. 解包 `app.asar` → 应用补丁 → 以目录形式就位（`app.asar.disabled` + `Resources/app/`）；
4. **重新签名**（ad-hoc，保留 identifier/entitlements/硬运行时标记）；
5. 打印下一步：在「系统设置 → 隐私与安全性」里给 DSH Desktop 打开**屏幕录制**和**音频捕获**（改签名后系统需要你重新确认这两个开关），然后重启 app。

> ⚠️ 打补丁会让 app 的**代码签名发生变化**——这是 macOS 机制决定的，无法回避。副作用仅限：
> - 系统授权列表里需要**重新打开一次** DSH Desktop 的开关（脚本结尾会指引）；
> - app 自带的**自动更新**会覆盖补丁（更新后重新跑一次脚本即可）。

## 回滚

```sh
rm -rf "/Applications/DSH Desktop.app"
cp -R ~/DSH-Desktop-<版本>-backup.app "/Applications/DSH Desktop.app"
```

（或直接重新安装官方 DMG。）回滚后同样需要在系统设置里重新确认一次权限。

## 补丁技术细节（给 reviewers）

`main.js.patch` 是相对**原版 `Resources/app.asar` 内 `lib/main.js`** 的 unified diff，包含两处改动：

1. `electron` import 行增加 `desktopCapturer, session`；
2. 插入一段 `dsh-audio-visualizer patch` 代码块（见 patch 内注释）。

关键点：主 UI 位于独立 session partition（`persist:dsh-desktop-renderer`），因此 handler 必须通过 `app.on('web-contents-created')` 对**每个 webContents 的 session** 注册——只挂 `session.defaultSession` 不生效。
