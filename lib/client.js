/**
 * dsh-audio-visualizer — 浏览器半
 *
 * 系统音频驱动的界面律动（效果对齐 Hermes Desktop 的 audio-visualizer 插件）：
 *   1. 悬浮 chip：48 段彩虹频谱条（118×24 canvas），可拖动、位置记忆
 *   2. 全窗边缘光晕：低音（bass）驱动的 inset 光晕
 *   3. 点击 chip 开 / 关；频谱全在内存里做 FFT —— 不落盘、不上传
 *
 * 数据通路（浏览器安全模型下的唯一合法路径）：
 *   getDisplayMedia（用户在弹窗里选「整个屏幕」+ 勾选「分享系统音频」）
 *   → 立即丢弃视频轨（只保留 system-audio 回环音轨）
 *   → AudioContext + AnalyserNode 纯内存 FFT
 *   → canvas 频谱 + overlay 光晕
 *
 * DSH Desktop 版：主进程已用 setDisplayMediaRequestHandler + loopback 自动授权
 * （见 README 的 patch/ 目录），因此点击即开启、无 picker 交互。
 * 为什么网页版需要用户手动选一次：网页无法像 Electron 主进程（Hermes Desktop
 * 用 setDisplayMediaRequestHandler + MacCatapLoopbackAudioForScreenShare）
 * 那样程序化取得系统声音 —— 这是浏览器安全模型，不是插件缺陷。
 * macOS 上需要 Chrome 141+（「分享系统音频」复选框从该版本开始出现）。
 *
 * 生命周期：cordis 0.1.5 —— ctx 是 Proxy，访问未声明属性会被 Guard 拒绝；
 * 清理副作用一律走 ctx.effect(() => disposer)。
 */
window.__ModuleLoader__.load({
  id: 'dsh-audio-visualizer',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const inject = []

    // ── 视觉参数（与 Hermes Desktop 版保持一致，保证观感一致）──
    const SEGS = 48
    const W = 118
    const H = 24

    // ── 频谱幅度调校（2026-11-03，与 Hermes Desktop 版同源）──────────
    // 三个叠加问题会让频谱「看着没起伏」：
    //  1) loopback 电平高，AnalyserNode 的 8bit 映射（-100/-30 dB）把整片低频
    //     饱和成 255 → 每帧都有柱子顶格，曲线看起来是平的；
    //  2) 512 点 FFT @48kHz = 93.75Hz/bin，48 段对数分频后前十来段全落在 bin 1，
    //     数值完全相同（看着是一整块，不是一根根独立动）；
    //  3) raw**0.78 压缩动态范围 + gain 把峰值钉死 1.0。
    // 修法：入 analyser 前 -9dB、2048 点 FFT、低段线性/高段对数混合分频、
    // 更陡的幂次 + 动态扩展 + 顶部留白。
    const PRE_GAIN = 0.35          // -9 dB（118×24 小画布；200×32 版用 -12dB）
    const FFT_SIZE = 2048
    const LEVEL_POWER = 1.10
    const LEVEL_FLOOR = 0.05
    const LEVEL_HEADROOM = 0.92
    const BAND_LOW_HZ = 40
    const BAND_MID_HZ = 500
    const BAND_TOP_HZ = 11000
    const LOW_SEGS = 15
    let bandEdges = null

    function buildBandEdges(sampleRate, binCount) {
      const binHz = sampleRate / FFT_SIZE
      const nb = Math.min(binCount, FFT_SIZE / 2)
      const f2b = (f) => Math.max(1, Math.min(nb - 1, Math.round(f / binHz)))
      const out = []
      for (let i = 0; i < SEGS; i++) {
        let f0, f1
        if (i < LOW_SEGS) {
          f0 = BAND_LOW_HZ + (BAND_MID_HZ - BAND_LOW_HZ) * (i / LOW_SEGS)
          f1 = BAND_LOW_HZ + (BAND_MID_HZ - BAND_LOW_HZ) * ((i + 1) / LOW_SEGS)
        } else {
          const t0 = (i - LOW_SEGS) / (SEGS - LOW_SEGS)
          const t1 = (i - LOW_SEGS + 1) / (SEGS - LOW_SEGS)
          f0 = BAND_MID_HZ * Math.pow(BAND_TOP_HZ / BAND_MID_HZ, t0)
          f1 = BAND_MID_HZ * Math.pow(BAND_TOP_HZ / BAND_MID_HZ, t1)
        }
        let lo = f2b(f0)
        let hi = f2b(f1)
        if (hi <= lo) hi = lo + 1
        out.push([lo, hi])
      }
      return out
    }

    const Z_CHIP = 2147483000
    const Z_GLOW = 2147482990
    const LS_POS = 'dsh-audio-visualizer.pos.v3'
    // 贴靠锚点：DSH 底部统计栏的「N 轮 M 步 · X tok/s」pill（ui-chat 的 ActivityPill
    // 渲染出的 data-composer-stat="activity"）。用它做动态锚点，窗口缩放/侧栏开合
    // 都能自动跟住，不再写死像素坐标。
    const ANCHOR_SEL = '[data-composer-stat="activity"]'
    const LS_ON = 'dsh-audio-visualizer.enabled'
    const LS_HINTED = 'dsh-audio-visualizer.hinted'
    // ── 版本切换（2026-11-02）：V1 = 经典 48 段频谱（原样保留）；V2 = 彩虹 LED 屏 ──
    // V2 参考视觉：长条 LED 频谱屏 —— 左红右紫的彩虹竖条、柱顶白色高光帽、
    // 柱间细缝、以及「条子落下时从顶端洒出的白色粒子」。
    // 两版共用同一 chip / 同一贴靠位置 / 同一套边缘辉光代码（辉光一行不改）。
    const LS_VER = 'dsh-audio-visualizer.version'
    // V2 与 V1 的 canvas 尺寸/段数必须完全一致（用户 2026-11-02 明确要求
    // 「V2 在状态栏占用的位置和大小跟 V1 完全一样」），差异只在绘制风格：
    // 单色彩虹柱 + 柱顶白帽 + 峰值帽 + 下降粒子。
    const V2_SEGS = SEGS
    const V2_W = W
    const V2_H = H
    const V2_HUE_SPAN = 300      // 红 → 紫（0..300），与 V1 同一色相跨度
    const V2_GRAVITY = 12        // 粒子的轻微重力（px/s²）—— 刻意很小，让粒子比频谱线落得慢
    const V2_PART_VMIN = 7       // 粒子初速下限（px/s）：慢
    const V2_PART_VMAX = 20      // 粒子初速上限（px/s）：速度差 3 倍 → 下落中自动拉开间距
    const V2_MAX_PARTS = 320     // 粒子上限，防长时间运行膨胀

    // ── 运行时状态（每次 apply 全新）──
    let stream = null
    let audioCtx = null
    let analyser = null
    let rafId = 0
    let gainPeak = 0.15
    let chipEl = null
    let canvasEl = null
    let dotEl = null
    let verEl = null
    let glowEl = null
    let toastEl = null
    let toastTimer = 0
    let starting = false
    let disposed = false
    let drag = null
    // 贴靠定位状态
    let manualPos = false      // 用户拖动过 → 用 localStorage 里的固定位置
    let lastLeft = null
    let lastTop = null
    let posTimer = 0
    let posPoll = 0
    // 版本状态
    let version = 'v1'
    const v2 = {
      prev: new Float32Array(V2_SEGS),
      parts: [],
      lastTs: 0,
      primed: false,
    }

    // ── 小工具 ──────────────────────────────────────────────
    function makeEl(tag, css, attrs) {
      const el = document.createElement(tag)
      if (css) el.style.cssText = css
      if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k])
      return el
    }

    function showToast(msg, ms) {
      try {
        if (!toastEl) {
          toastEl = makeEl(
            'div',
            'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:' + Z_CHIP +
              ';max-width:min(560px,86vw);padding:9px 14px;border-radius:10px;' +
              'background:rgba(24,26,34,.92);color:#E8EBF2;font:13px/1.5 system-ui,-apple-system,sans-serif;' +
              'border:1px solid rgba(255,255,255,.12);box-shadow:0 10px 30px rgba(0,0,0,.35);' +
              'backdrop-filter:blur(10px);pointer-events:none;opacity:0;transition:opacity .18s ease;',
            { 'data-dsh-av-toast': '1' }
          )
          document.body.appendChild(toastEl)
        }
        toastEl.textContent = msg
        toastEl.style.opacity = '1'
        if (toastTimer) clearTimeout(toastTimer)
        toastTimer = setTimeout(() => {
          toastTimer = 0
          if (toastEl) toastEl.style.opacity = '0'
        }, ms || 3200)
      } catch (e) {
        /* 提示失败无伤大雅 */
      }
    }

    function setUI(on) {
      if (dotEl) {
        dotEl.style.background = on ? '#7dd3fc' : 'rgba(148,163,184,.55)'
        dotEl.style.boxShadow = on ? '0 0 8px rgba(125,211,252,.9)' : 'none'
        dotEl.classList.remove('dsh-av-hint')
      }
      if (chipEl) {
        chipEl.style.opacity = on ? '1' : '0.72'
        chipEl.title = on
          ? '音频律动：开启中 — 点击关闭'
          : '音频律动：点击开启（跟随系统声音；需在弹窗里选「整个屏幕」并勾选「分享系统音频」）'
      }
    }

    // ── V1 频谱绘制（对齐 Hermes Desktop 版的算法；2026-11-02 原样保留）─────
    function drawV1Idle() {
      if (!canvasEl) return
      const ctx2d = canvasEl.getContext('2d')
      const dpr = window.devicePixelRatio || 2
      if (canvasEl.width !== W * dpr || canvasEl.height !== H * dpr) {
        canvasEl.width = W * dpr
        canvasEl.height = H * dpr
      }
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx2d.clearRect(0, 0, W, H)
      const bw = W / SEGS
      for (let i = 0; i < SEGS; i++) {
        ctx2d.fillStyle = 'rgba(148,163,184,.30)'
        ctx2d.fillRect(i * bw, H - 1.5, Math.max(1.2, bw - 0.7), 1.5)
      }
    }

    function drawV1Frame(bins, levels) {
      if (!canvasEl) return
      const ctx2d = canvasEl.getContext('2d')
      const dpr = window.devicePixelRatio || 2
      if (canvasEl.width !== W * dpr || canvasEl.height !== H * dpr) {
        canvasEl.width = W * dpr
        canvasEl.height = H * dpr
      }
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx2d.clearRect(0, 0, W, H)
      const bw = W / SEGS
      for (let i = 0; i < SEGS; i++) {
        const h = Math.max(1.5, levels[i] * (H - 2))
        ctx2d.fillStyle =
          'hsl(' + Math.round((i / (SEGS - 1)) * 300) + ' 90% ' + (46 + levels[i] * 30) + '%)'
        ctx2d.globalAlpha = 0.5 + levels[i] * 0.5
        ctx2d.fillRect(i * bw, H - h, Math.max(1.2, bw - 0.7), h)
      }
      ctx2d.globalAlpha = 1
    }

    // ── V2：彩虹 LED 频谱条 + 下落粒子（2026-11-02 新增，V1 不受影响）──
    // 视觉对齐参考截图：左红右紫的彩虹竖条、柱顶白色高光帽、柱间细缝、
    // 条子落下时从顶端洒出的白色粒子；柱子本体单色（无自身渐变）。
    function v2hue(i) {
      return Math.round((i / (V2_SEGS - 1)) * V2_HUE_SPAN)
    }

    function v2Setup() {
      const c = canvasEl.getContext('2d')
      const dpr = window.devicePixelRatio || 2
      if (canvasEl.width !== V2_W * dpr || canvasEl.height !== V2_H * dpr) {
        canvasEl.width = V2_W * dpr
        canvasEl.height = V2_H * dpr
      }
      c.setTransform(dpr, 0, 0, dpr, 0, 0)
      c.clearRect(0, 0, V2_W, V2_H)
      return c
    }

    function resetV2State() {
      v2.prev.fill(0)
      if (v2.parts.length) v2.parts.length = 0
      v2.lastTs = 0
      v2.primed = false
    }

    // 连续彩虹带用的横向渐变（红 → 紫，12 个色标）
    function v2RainbowGradient(c) {
      const g = c.createLinearGradient(0, 0, V2_W, 0)
      for (let i = 0; i <= 12; i++) {
        g.addColorStop(i / 12, 'hsl(' + i * 25 + ' 92% 56%)')
      }
      return g
    }

    function v2TraceTop(c, pts) {
      const bw = V2_W / V2_SEGS
      c.moveTo(0, pts[0])
      for (let i = 1; i < V2_SEGS; i++) c.lineTo(i * bw + bw / 2, pts[i])
      c.lineTo(V2_W, pts[V2_SEGS - 1])
    }

    function drawV2Idle() {
      if (!canvasEl) return
      const c = v2Setup()
      c.globalAlpha = 0.18
      c.fillStyle = v2RainbowGradient(c)
      c.fillRect(0, V2_H - 2, V2_W, 2)
      c.globalAlpha = 1
      resetV2State()
    }

    function drawV2Frame(levels) {
      if (!canvasEl) return
      const c = v2Setup()
      const bw = V2_W / V2_SEGS
      const innerH = V2_H - 2
      const now = performance.now()
      const dt = v2.lastTs ? Math.min(0.05, (now - v2.lastTs) / 1000) : 0.016
      v2.lastTs = now

      // 1) 状态更新：某段掉下去 → 在它原来的顶端滴出一颗粒子
      //    频谱线是「瞬落」，粒子是「缓慢飘落」：初速仅 7–20px/s、重力 12px/s²，
      //    且同一列的多颗粒子速度不同 → 下落途中彼此越拉越开。
      for (let i = 0; i < V2_SEGS; i++) {
        const lv = levels[i] || 0
        const pv = v2.prev[i]
        if (v2.primed && pv - lv > 0.012) {
          const topY = V2_H - Math.max(1.2, pv * innerH)
          const n = Math.min(2, 1 + Math.round((pv - lv) * 6))
          for (let k = 0; k < n; k++) {
            if (v2.parts.length >= V2_MAX_PARTS) break
            v2.parts.push({
              x: i * bw + bw * 0.5 + (Math.random() - 0.5) * bw * 0.6,
              y: topY + Math.random() * 0.8,
              vx: (Math.random() - 0.5) * 4,
              vy: V2_PART_VMIN + Math.random() * (V2_PART_VMAX - V2_PART_VMIN),
              life: 1,
              decay: 1 / (1.5 + Math.random() * 1.5),
              hue: v2hue(i),
              size: 0.7 + Math.random() * 0.8,
            })
          }
        }
        v2.prev[i] = lv
      }
      v2.primed = true

      // 2) 连续彩虹带：一条不间断的渐变填充（顶部随频谱起伏，底部齐平）
      const pts = new Array(V2_SEGS)
      for (let i = 0; i < V2_SEGS; i++) {
        pts[i] = V2_H - Math.max(1.2, (levels[i] || 0) * innerH)
      }
      c.beginPath()
      c.moveTo(0, V2_H)
      c.lineTo(0, pts[0])
      for (let i = 1; i < V2_SEGS; i++) c.lineTo(i * bw + bw / 2, pts[i])
      c.lineTo(V2_W, pts[V2_SEGS - 1])
      c.lineTo(V2_W, V2_H)
      c.closePath()
      c.fillStyle = v2RainbowGradient(c)
      c.fill()

      // 3) 顶部亮边（LED 灯管高光）
      c.beginPath()
      v2TraceTop(c, pts)
      c.strokeStyle = 'rgba(255,255,255,.42)'
      c.lineWidth = 0.8
      c.stroke()

      // 4) 粒子：慢速飘落 + 平方渐隐，落到屏底回收
      const parts = v2.parts
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]
        p.vy += V2_GRAVITY * dt
        p.x += p.vx * dt
        p.y += p.vy * dt
        p.life -= p.decay * dt
        if (p.life <= 0 || p.y > V2_H + 2) {
          parts.splice(i, 1)
          continue
        }
        const a = p.life * p.life
        c.fillStyle = 'hsla(' + p.hue + ', 100%, 94%, ' + a.toFixed(3) + ')'
        c.fillRect(p.x, p.y, p.size, p.size)
      }
    }

    // ── 绘制分派：同一 chip 内按版本走不同引擎 ──────────────
    function drawIdle() {
      if (version === 'v2') return drawV2Idle()
      return drawV1Idle()
    }

    function drawFrame(bins, levels) {
      if (version === 'v2') return drawV2Frame(levels)
      return drawV1Frame(bins, levels)
    }

    // ── 版本切换 UI（chip 右侧的小徽标 1 / 2）──────────────
    function canvasSize() {
      return version === 'v2' ? { w: V2_W, h: V2_H } : { w: W, h: H }
    }

    function applyVersionUI() {
      const sz = canvasSize()
      if (canvasEl) {
        canvasEl.style.width = sz.w + 'px'
        canvasEl.style.height = sz.h + 'px'
        // V2 的 LED 屏整体带一层很淡的冷色晕（粒子/柱子的辉光感）
        canvasEl.style.filter =
          version === 'v2' ? 'drop-shadow(0 0 4px rgba(125,211,252,.18))' : 'none'
      }
      if (verEl) {
        verEl.textContent = version === 'v2' ? '2' : '1'
        verEl.title =
          version === 'v2'
            ? '律动版本 V2 · 彩虹 LED（点击切回 V1 经典）'
            : '律动版本 V1 · 经典（点击切到 V2 彩虹 LED）'
        verEl.style.color = version === 'v2' ? '#7dd3fc' : 'rgba(203,213,225,.55)'
        verEl.style.background = 'transparent'
        verEl.style.borderColor =
          version === 'v2' ? 'rgba(125,211,252,.55)' : 'rgba(255,255,255,.12)'
      }
      // 宽度变了 → 清缓存强制重新贴靠（右边缘仍锁在统计 pill 左侧）
      lastLeft = null
      lastTop = null
      placeChip()
      if (!stream) drawIdle()
      else resetV2State()
    }

    function setVersion(v, silent) {
      version = v === 'v2' ? 'v2' : 'v1'
      try {
        localStorage.setItem(LS_VER, version)
      } catch (e) {}
      applyVersionUI()
      if (!silent) {
        showToast(
          version === 'v2'
            ? '音频律动：V2 彩虹 LED（彩虹条 + 粒子下落）'
            : '音频律动：V1 经典频谱'
        )
      }
    }

    function loop() {
      if (!analyser) return
      const bins = new Uint8Array(analyser.frequencyBinCount)
      analyser.getByteFrequencyData(bins)

      const raw = []
      const edges = bandEdges || []
      for (let i = 0; i < SEGS; i++) {
        const e = edges[i] || [1, 2]
        const lo = e[0]
        const hi = Math.min(e[1], bins.length)
        let sum = 0
        for (let k = lo; k < hi; k++) sum += bins[k] || 0
        raw.push(sum / Math.max(1, hi - lo) / 255)
      }
      const curved = raw.map((v) => Math.pow(v, LEVEL_POWER))
      gainPeak = Math.max(gainPeak * 0.975, Math.max.apply(null, curved))
      // 灵敏度地板 0.12 -> 0.05（2026-09-12）：Electron 43 的 loopback 跟随系统音量，
      // 小音量输入下 0.12 地板会卡住放大倍数导致条偏矮；0.05 让弱信号也能顶格，
      // 强信号不受影响（gainPeak 高于地板时该值不起作用）。
      const gain = 1 / Math.max(gainPeak, 0.05)
      // 动态扩展（下切 LEVEL_FLOOR）+ 顶部留白：让起伏更明显、不再每帧削顶
      const levels = curved.map((v) => {
        const g = Math.min(1, v * gain)
        const ex = Math.max(0, (g - LEVEL_FLOOR) / (1 - LEVEL_FLOOR))
        return Math.min(LEVEL_HEADROOM, ex)
      })

      drawFrame(bins, levels)

      // 边缘光晕（低音驱动 bin 2..10 ≈ 170–940Hz @ 48kHz）
      if (glowEl) {
        let bs = 0
        for (let k = 2; k <= 10; k++) bs += bins[k] || 0
        const bass = Math.min(1, Math.pow(bs / 9 / 255 / PRE_GAIN, 0.6) * 2.2)
        glowEl.style.opacity = '1'
        glowEl.style.boxShadow =
          'inset 0 0 ' + (10 + bass * 46) + 'px hsla(' + Math.round(210 - bass * 190) +
          ' 88% 62% / ' + (0.06 + bass * 0.5).toFixed(3) + ')'
      }
      rafId = requestAnimationFrame(loop)
    }

    // ── 启停 ────────────────────────────────────────────────
    function hardStop(silent) {
      if (rafId) {
        cancelAnimationFrame(rafId)
        rafId = 0
      }
      try {
        if (stream) stream.getTracks().forEach((t) => t.stop())
      } catch (e) {}
      stream = null
      try {
        if (audioCtx) audioCtx.close()
      } catch (e) {}
      audioCtx = null
      analyser = null
      if (glowEl) {
        glowEl.style.opacity = '0'
        glowEl.style.boxShadow = 'none'
      }
      drawIdle()
      if (!silent) setUI(false)
    }

    async function start() {
      hardStop(true)
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        showToast('当前浏览器不支持屏幕/系统音频捕获（需要 Chrome 141+ 且 macOS 14.2+）')
        return
      }
      // 首选带 systemAudio:'include'（Chrome 141+ 的约束：默认勾选「分享系统音频」）；
      // 约束不被理解时 TypeError → 降级为普通 audio:true 再试一次。
      let s = null
      const videoOpt = { width: { ideal: 4 }, height: { ideal: 4 }, frameRate: { ideal: 1 } }
      const audioOpt = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        systemAudio: 'include',
      }
      try {
        s = await navigator.mediaDevices.getDisplayMedia({ video: videoOpt, audio: audioOpt })
      } catch (err) {
        if (err && err.name === 'TypeError') {
          s = await navigator.mediaDevices.getDisplayMedia({ video: videoOpt, audio: true })
        } else {
          throw err
        }
      }
      if (!s.getAudioTracks().length) {
        try {
          s.getTracks().forEach((t) => t.stop())
        } catch (e) {}
        throw new Error('no-audio')
      }
      // 有音轨：立刻丢弃占位视频轨（不再录制屏幕画面，只剩系统音频回环）
      s.getVideoTracks().forEach((t) => {
        try {
          t.stop()
        } catch (e) {}
        try {
          s.removeTrack(t)
        } catch (e) {}
      })
      stream = s

      audioCtx = new (window.AudioContext || window.webkitAudioContext)()
      if (audioCtx.state === 'suspended') {
        try {
          await audioCtx.resume()
        } catch (e) {}
      }
      const src = audioCtx.createMediaStreamSource(s)
      analyser = audioCtx.createAnalyser()
      analyser.fftSize = FFT_SIZE
      analyser.smoothingTimeConstant = 0.4
      bandEdges = buildBandEdges(audioCtx.sampleRate, analyser.frequencyBinCount)
      // 入 analyser 前衰减，避免 8bit 映射把低频整片饱和
      const preGain = audioCtx.createGain()
      preGain.gain.value = PRE_GAIN
      src.connect(preGain)
      preGain.connect(analyser)

      // 用户从浏览器 UI 停止共享 → 自动复位
      s.getAudioTracks()[0].addEventListener('ended', () => {
        hardStop()
        showToast('系统音频共享已停止')
      })

      gainPeak = 0.15
      try {
        localStorage.setItem(LS_ON, '1')
      } catch (e) {}
      setUI(true)
      loop()
    }

    async function toggle() {
      if (starting) return
      if (stream) {
        hardStop()
        try {
          localStorage.setItem(LS_ON, '0')
        } catch (e) {}
        return
      }
      starting = true
      try {
        await start()
      } catch (err) {
        hardStop(true)
        setUI(false)
        const name = err && err.name
        if (name === 'NotAllowedError') {
          showToast('捕获被拒绝 —— 请确认已运行 patch/ 安装脚本，并在系统设置里完成「屏幕录制」授权')
        } else if (String(err && err.message) === 'no-audio') {
          showToast('没有拿到系统音频 —— 请检查系统设置里 DSH Desktop 的「屏幕录制」和「音频捕获」权限；若未打过补丁，见插件 README 的 patch/ 目录')
        } else {
          showToast('启动失败：' + String((err && err.message) || err))
        }
      } finally {
        starting = false
      }
    }

    // ── 定位：贴住底部统计栏的「N 轮 M 步 · X tok/s」pill 左侧 ──────────
    // 为什么不再写死像素：DSH 的状态栏由 flex 排布，窗口宽度 / 侧栏开合 /
    // 会话统计文字变长都会让 pill 横向移动。写死 left 必然错位（历史坑：
    // left:258px 在 1080p 窗口里离 pill 还有 140px）。改为每帧量 anchor 的
    // boundingClientRect 再贴到它左边，天然跟随。
    function findAnchor() {
      try {
        const list = document.querySelectorAll(ANCHOR_SEL)
        for (let i = 0; i < list.length; i++) {
          const r = list[i].getBoundingClientRect()
          if (r.width >= 40 && r.height >= 12) return r
        }
      } catch (e) {}
      return null
    }

    function readSavedPos() {
      try {
        const p = JSON.parse(localStorage.getItem(LS_POS) || 'null')
        if (p && typeof p.left === 'number' && typeof p.top === 'number') return p
      } catch (e) {}
      return null
    }

    function placeChip() {
      if (!chipEl || drag) return
      const w = chipEl.offsetWidth || 140
      const h = chipEl.offsetHeight || 34
      let left
      let top
      const saved = manualPos ? readSavedPos() : null
      if (saved) {
        // 用户拖动过 → 尊重手动位置（双击 chip 可恢复贴靠）
        left = Math.min(Math.max(4, saved.left), Math.max(4, window.innerWidth - w - 4))
        top = Math.min(Math.max(4, saved.top), Math.max(4, window.innerHeight - h - 4))
      } else {
        const r = findAnchor()
        if (r) {
          left = Math.max(4, Math.round(r.left - w - 6))
          top = Math.max(4, Math.round(r.top + (r.height - h) / 2))
        } else {
          // anchor 还没渲染（启动早期 / 空会话无统计）→ 先蹲在底部左侧
          left = 8
          top = Math.max(4, window.innerHeight - h - 6)
        }
      }
      if (left === lastLeft && top === lastTop) return
      lastLeft = left
      lastTop = top
      chipEl.style.left = left + 'px'
      chipEl.style.top = top + 'px'
      chipEl.style.right = 'auto'
      chipEl.style.bottom = 'auto'
    }

    function schedulePlace(delay) {
      if (posTimer) return
      posTimer = setTimeout(() => {
        posTimer = 0
        placeChip()
      }, delay || 120)
    }

    function onWindowResize() {
      schedulePlace(60)
    }

    function boot() {
      if (disposed || !document.body) return
      if (document.querySelector('[data-dsh-av-chip]')) return
      if (window.__dshAudioVisualizerInstalled !== true) return

      // 样式（一次性，挂 <head>）
      const style = makeEl('style', null, { 'data-dsh-av-style': '1' })
      style.textContent =
        '[data-dsh-av-chip]{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:11px;' +
        'background:rgba(22,24,32,.78);border:1px solid rgba(255,255,255,.10);' +
        '-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);' +
        'cursor:grab;user-select:none;touch-action:none;transition:opacity .15s ease;' +
        'box-shadow:0 6px 22px rgba(0,0,0,.30);}' +
        '[data-dsh-av-chip]:hover{opacity:1!important;}' +
        '[data-dsh-av-chip].dsh-av-dragging{cursor:grabbing;}' +
        '[data-dsh-av-dot]{width:5px;height:5px;border-radius:50%;flex:0 0 auto;' +
        'background:rgba(148,163,184,.55);transition:background .2s ease;}' +
        '[data-dsh-av-ver]{font:700 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;' +
        'letter-spacing:.02em;padding:3px 4px 2px;border-radius:5px;' +
        'border:1px solid rgba(255,255,255,.12);color:rgba(203,213,225,.55);' +
        'flex:0 0 auto;cursor:pointer;user-select:none;transition:color .15s ease,border-color .15s ease;}' +
        '[data-dsh-av-ver]:hover{color:#E8EBF2!important;border-color:rgba(255,255,255,.32)!important;}' +
        '[data-dsh-av-dot].dsh-av-hint{animation:dsh-av-pulse 1.6s ease-in-out infinite;}' +
        '@keyframes dsh-av-pulse{0%,100%{opacity:.35}50%{opacity:1}}'
      ;(document.head || document.documentElement).appendChild(style)

      // 全窗边缘光晕层（常驻，pointer-events:none）
      glowEl = makeEl(
        'div',
        'position:fixed;inset:0;pointer-events:none;z-index:' + Z_GLOW +
          ';opacity:0;transition:opacity 120ms linear;',
        { 'data-dsh-av-glow': '1' }
      )
      document.body.appendChild(glowEl)

      // 悬浮 chip（初始放屏幕外，placeChip 会立刻贴到统计栏左侧）
      chipEl = makeEl(
        'div',
        'position:fixed;z-index:' + Z_CHIP + ';left:-9999px;top:0;opacity:.72;',
        {
          'data-dsh-av-chip': '1',
          title: '音频律动：点击开启（跟随系统声音；需在弹窗里选「整个屏幕」并勾选「分享系统音频」）',
        }
      )
      canvasEl = makeEl('canvas', 'display:block;pointer-events:none;', {
        'data-av-spectrum': '1',
      })
      dotEl = makeEl('span', null, { 'data-dsh-av-dot': '1' })
      // 版本徽标：点它切换 V1 / V2（不触发 chip 的开关与拖动）
      verEl = makeEl('span', null, { 'data-dsh-av-ver': '1' })
      chipEl.appendChild(canvasEl)
      chipEl.appendChild(dotEl)
      chipEl.appendChild(verEl)
      document.body.appendChild(chipEl)

      // 版本徽标只吃自己的指针事件，冒泡到 chip 会变成「开关」或「拖动」
      verEl.addEventListener('pointerdown', (e) => {
        e.stopPropagation()
      })
      verEl.addEventListener('pointerup', (e) => {
        e.stopPropagation()
        setVersion(version === 'v2' ? 'v1' : 'v2')
      })

      // 记住上次选的版本（默认 V1，不改变既有观感）
      try {
        version = localStorage.getItem(LS_VER) === 'v2' ? 'v2' : 'v1'
      } catch (e) {
        version = 'v1'
      }

      // 上次开着 → dot 轻呼吸提示「可恢复」（浏览器要求手势，无法自动重开）
      let wasOn = false
      try {
        wasOn = localStorage.getItem(LS_ON) === '1'
      } catch (e) {}
      if (wasOn) dotEl.classList.add('dsh-av-hint')

      // 拖动 / 点击
      chipEl.addEventListener('pointerdown', (e) => {
        const r = chipEl.getBoundingClientRect()
        drag = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false }
        try {
          chipEl.setPointerCapture(e.pointerId)
        } catch (err) {}
      })
      chipEl.addEventListener('pointermove', (e) => {
        if (!drag) return
        const dx = e.clientX - drag.sx
        const dy = e.clientY - drag.sy
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return
        drag.moved = true
        chipEl.classList.add('dsh-av-dragging')
        const w = chipEl.offsetWidth
        const h = chipEl.offsetHeight
        const left = Math.min(Math.max(4, drag.ox + dx), Math.max(4, window.innerWidth - w - 4))
        const top = Math.min(Math.max(4, drag.oy + dy), Math.max(4, window.innerHeight - h - 4))
        chipEl.style.left = left + 'px'
        chipEl.style.top = top + 'px'
        chipEl.style.right = 'auto'
        chipEl.style.bottom = 'auto'
      })
      const endDrag = (e) => {
        if (!drag) return
        const moved = drag.moved
        drag = null
        chipEl.classList.remove('dsh-av-dragging')
        if (moved) {
          try {
            const r = chipEl.getBoundingClientRect()
            const p = { left: Math.round(r.left), top: Math.round(r.top) }
            localStorage.setItem(LS_POS, JSON.stringify(p))
            manualPos = true
            lastLeft = p.left
            lastTop = p.top
          } catch (err) {}
        } else {
          toggle()
        }
      }
      chipEl.addEventListener('pointerup', endDrag)
      chipEl.addEventListener('pointercancel', endDrag)

      // 右键 → 撤销手动位置，重新贴回底部统计栏左侧
      chipEl.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        try {
          localStorage.removeItem(LS_POS)
        } catch (err) {}
        manualPos = false
        lastLeft = null
        lastTop = null
        placeChip()
        showToast('音频律动：已恢复贴靠底部统计栏')
      })

      manualPos = !!readSavedPos()
      // 按当前版本设 canvas 尺寸 + 徽标样式，并贴靠（内部含 placeChip + drawIdle）
      applyVersionUI()
      // 跟随：窗口尺寸变化（滚轮缩放/全屏切换）+ 1.5s 轮询兜底
      // （统计文字从「9 轮 12 步」变成「19 轮 175 步」会把 pill 往右推，不触发 resize）
      window.addEventListener('resize', onWindowResize)
      posPoll = setInterval(placeChip, 1500)
      setUI(false)

      // 首次升级到双版本时提示一次「哪里可以切」
      try {
        if (!localStorage.getItem('dsh-audio-visualizer.v2hinted')) {
          localStorage.setItem('dsh-audio-visualizer.v2hinted', '1')
          setTimeout(
            () => showToast('音频律动新增 V2 彩虹 LED：点 chip 右侧的 1 / 2 徽标切换版本'),
            1400
          )
        }
      } catch (e) {}

      // DSH Desktop（Electron + 主进程 loopback 补丁）：无手势、无 picker —— 启动即自动开启
      // （浏览器版无法做到：getDisplayMedia 强制要求用户手势 + 弹窗）
      if (/Electron|DSHDesktop/i.test(navigator.userAgent) && !window.__dshAudioVisualizerAutoStarted) {
        window.__dshAudioVisualizerAutoStarted = true
        setTimeout(() => {
          if (!stream && !starting && !disposed) {
            toggle().catch(() => {})
          }
        }, 2200)
      }
    }

    // ── 插件入口 ────────────────────────────────────────────
    function apply(ctx) {
      if (typeof document === 'undefined' || typeof window === 'undefined') return
      if (window.__dshAudioVisualizerInstalled) return
      window.__dshAudioVisualizerInstalled = true
      disposed = false

      const onReady = () => boot()
      if (document.body) boot()
      else document.addEventListener('DOMContentLoaded', onReady, { once: true })

      // 离屏验证钩子：只在 URL 带 dsh-av-test=1 时挂载（生产环境不暴露任何入口）
      try {
        if (/[?&]dsh-av-test=1/.test(location.search)) {
          window.__dshAVTest = {
            setVersion: setVersion,
            getVersion: () => version,
            idle: () => drawIdle(),
            frame: (levels) => drawFrame(null, levels),
            parts: () => v2.parts.length,
            chipRect: () => (chipEl ? chipEl.getBoundingClientRect() : null),
            anchorRect: () => findAnchor(),
          }
        }
      } catch (e) {}

      const stop = () => {
        if (disposed) return
        disposed = true
        document.removeEventListener('DOMContentLoaded', onReady)
        window.removeEventListener('resize', onWindowResize)
        if (posPoll) {
          clearInterval(posPoll)
          posPoll = 0
        }
        if (posTimer) {
          clearTimeout(posTimer)
          posTimer = 0
        }
        drag = null
        lastLeft = null
        lastTop = null
        hardStop(true)
        if (toastTimer) {
          clearTimeout(toastTimer)
          toastTimer = 0
        }
        try {
          if (chipEl) chipEl.remove()
        } catch (e) {}
        try {
          if (glowEl) glowEl.remove()
        } catch (e) {}
        try {
          if (toastEl) toastEl.remove()
        } catch (e) {}
        try {
          const st = document.querySelector('[data-dsh-av-style]')
          if (st) st.remove()
        } catch (e) {}
        chipEl = canvasEl = dotEl = verEl = glowEl = toastEl = null
        try {
          delete window.__dshAudioVisualizerInstalled
        } catch (e) {}
      }

      // cordis 0.1.5：清理副作用一律走官方规范 ctx.effect(() => disposer)。
      ctx.effect(() => stop)
      return stop
    }

    module.exports = { apply, inject }
    return module.exports
  },
})
