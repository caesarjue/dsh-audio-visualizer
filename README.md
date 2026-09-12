# dsh-audio-visualizer

**English** | [简体中文](README.zh.md)

System-audio driven UI visualizer for DeepSeek Harness (**dsh web** and **DSH Desktop**).

- **Spectrum chip** — a draggable 118×24 floating chip drawing a 48-band rainbow spectrum that rides the system audio output in real time.
- **Frame glow** — the window gets a bass-driven inset glow (10–56 px spread, hue shifts with the low end).
- **Memory-only FFT** — audio is analysed with a Web Audio `AnalyserNode` and never leaves the process: nothing is recorded, stored, or uploaded.
- Click the chip to toggle. It remembers where you put it.

## How it works

`getDisplayMedia({ audio })` → drop the placeholder video track → `AnalyserNode` (fftSize 512, smoothing 0.5) → log-spaced 48-band mapping over the FFT bins → dynamic peak gain → canvas.

On **DSH Desktop** the Electron main process answers `getDisplayMedia` with `audio: 'loopback'` for every renderer session, so the visualizer starts with the app — no dialog, no clicks. That requires a one-time local patch (see below).

## Install

### dsh web

```sh
dsh plugin --profile web add git+https://github.com/caesarjue/dsh-audio-visualizer
```

Then click the chip and pick **Entire screen** + check **Share system audio** in the picker. The browser security model requires this manual opt-in every time; macOS Chrome/Chromium 141+ only.

### DSH Desktop

```sh
dsh plugin --profile desktop add git+https://github.com/caesarjue/dsh-audio-visualizer
```

**Plus a one-time local patch** — the DSH Desktop Electron main process must answer `getDisplayMedia` with system-audio loopback. The patch script is bundled in `patch/`:

```sh
./patch/install-patch.sh   # backs up the app, patches main.js, re-signs, guides the macOS permission
```

See `patch/README.md` for the details (and rollback). After the patch the visualizer starts with the app, zero interaction.

## Requirements

- macOS 14.2+ (system-audio loopback via Core Audio taps); macOS permissions: **Screen Recording** + **Audio Capture** (grant in System Settings, then restart the app once)
- Chrome/Chromium 141+ for the web version
- DSH Desktop 2.0.5+ (Electron 43) tested; DSH web tested on dsh 0.1.5

## Files

- `package.json` / `cordis.patch.yml` / `lib/` — the plugin itself (`dsh.bundle` manifest declared)
- `patch/` — the optional DSH Desktop main-process patch (script + patch file + README)

## License

MIT
