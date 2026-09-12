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
    const Z_CHIP = 2147483000
    const Z_GLOW = 2147482990
    const LS_POS = 'dsh-audio-visualizer.pos'
    const LS_ON = 'dsh-audio-visualizer.enabled'
    const LS_HINTED = 'dsh-audio-visualizer.hinted'

    // ── 运行时状态（每次 apply 全新）──
    let stream = null
    let audioCtx = null
    let analyser = null
    let rafId = 0
    let gainPeak = 0.15
    let chipEl = null
    let canvasEl = null
    let dotEl = null
    let glowEl = null
    let toastEl = null
    let toastTimer = 0
    let starting = false
    let disposed = false
    let drag = null

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

    // ── 频谱绘制（对齐 Hermes Desktop 版的算法）─────────────
    function drawIdle() {
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

    function drawFrame(bins, levels) {
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

    function loop() {
      if (!analyser) return
      const bins = new Uint8Array(analyser.frequencyBinCount)
      analyser.getByteFrequencyData(bins)

      const raw = []
      for (let i = 0; i < SEGS; i++) {
        const lo = Math.max(1, Math.floor(Math.pow(250, i / SEGS)))
        const hi = Math.max(lo + 1, Math.floor(Math.pow(250, (i + 1) / SEGS)))
        let sum = 0
        for (let k = lo; k < hi; k++) sum += bins[k] || 0
        raw.push(sum / (hi - lo) / 255)
      }
      const curved = raw.map((v) => Math.pow(v, 0.78))
      gainPeak = Math.max(gainPeak * 0.975, Math.max.apply(null, curved))
      // 灵敏度地板 0.12 -> 0.05（2026-09-12）：Electron 43 的 loopback 跟随系统音量，
      // 小音量输入下 0.12 地板会卡住放大倍数导致条偏矮；0.05 让弱信号也能顶格，
      // 强信号不受影响（gainPeak 高于地板时该值不起作用）。
      const gain = 1 / Math.max(gainPeak, 0.05)
      const levels = curved.map((v) => Math.min(1, v * gain))

      drawFrame(bins, levels)

      // 边缘光晕（低音驱动 bin 2..10 ≈ 170–940Hz @ 48kHz）
      if (glowEl) {
        let bs = 0
        for (let k = 2; k <= 10; k++) bs += bins[k] || 0
        const bass = Math.min(1, Math.pow(bs / 9 / 255, 0.6) * 2.2)
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
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.5
      src.connect(analyser)

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

    // ── UI 组装 ─────────────────────────────────────────────
    function applyPos() {
      if (!chipEl) return
      let pos = null
      try {
        pos = JSON.parse(localStorage.getItem(LS_POS) || 'null')
      } catch (e) {}
      if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
        const w = chipEl.offsetWidth || 150
        const h = chipEl.offsetHeight || 36
        pos.left = Math.min(Math.max(4, pos.left), Math.max(4, window.innerWidth - w - 4))
        pos.top = Math.min(Math.max(4, pos.top), Math.max(4, window.innerHeight - h - 4))
        chipEl.style.left = pos.left + 'px'
        chipEl.style.top = pos.top + 'px'
        chipEl.style.right = 'auto'
        chipEl.style.bottom = 'auto'
      } else {
        chipEl.style.right = '16px'
        chipEl.style.bottom = '142px'
        chipEl.style.left = 'auto'
        chipEl.style.top = 'auto'
      }
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

      // 悬浮 chip
      chipEl = makeEl(
        'div',
        'position:fixed;z-index:' + Z_CHIP + ';right:16px;bottom:142px;opacity:.72;',
        {
          'data-dsh-av-chip': '1',
          title: '音频律动：点击开启（跟随系统声音；需在弹窗里选「整个屏幕」并勾选「分享系统音频」）',
        }
      )
      canvasEl = makeEl('canvas', 'width:' + W + 'px;height:' + H + 'px;display:block;pointer-events:none;', {
        'data-av-spectrum': '1',
      })
      dotEl = makeEl('span', null, { 'data-dsh-av-dot': '1' })
      chipEl.appendChild(canvasEl)
      chipEl.appendChild(dotEl)
      document.body.appendChild(chipEl)

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
            localStorage.setItem(LS_POS, JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) }))
          } catch (err) {}
        } else {
          toggle()
        }
      }
      chipEl.addEventListener('pointerup', endDrag)
      chipEl.addEventListener('pointercancel', endDrag)

      applyPos()
      drawIdle()
      setUI(false)

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

      const stop = () => {
        if (disposed) return
        disposed = true
        document.removeEventListener('DOMContentLoaded', onReady)
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
        chipEl = canvasEl = dotEl = glowEl = toastEl = null
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
