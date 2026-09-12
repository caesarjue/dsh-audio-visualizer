#!/bin/bash
# dsh-audio-visualizer — DSH Desktop main-process patch installer
#
# Adds the system-audio loopback answer for getDisplayMedia() to DSH Desktop,
# so the dsh-audio-visualizer plugin can run with zero interaction.
#
# What it does:
#   0. checks preconditions (app present, node present, codesign present)
#   1. backs up the whole app to ~/DSH-Desktop-<version>-backup.app
#   2. quits DSH Desktop
#   3. extracts app.asar (or reuses an already-extracted Resources/app)
#   4. applies a small patch to lib/main.js (idempotent)
#   5. deploys it as a directory bundle (app.asar.disabled + Resources/app/)
#   6. re-signs the app ad-hoc, preserving identifier/entitlements/flags
#   7. prints the macOS permission steps and launches the app
#
# Rollback: remove /Applications/DSH Desktop.app and copy the backup back.
#
# Environment overrides: DSH_APP=/path/to/DSH Desktop.app
set -euo pipefail

APP="${DSH_APP:-/Applications/DSH Desktop.app}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== dsh-audio-visualizer: DSH Desktop patch installer ==="

# ── 0. preconditions ─────────────────────────────────────────────
[ -d "$APP" ] || { echo "ERROR: app not found at: $APP (set DSH_APP to override)"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js is required (for asar handling)"; exit 1; }
command -v codesign >/dev/null 2>&1 || { echo "ERROR: macOS codesign not available"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 is required"; exit 1; }

VERSION="$(defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo unknown)"
RES="$APP/Contents/Resources"
BACKUP="$HOME/DSH-Desktop-${VERSION}-backup.app"

echo "app:     $APP (version $VERSION)"
echo "backup:  $BACKUP"

# ── 1. backup ────────────────────────────────────────────────────
if [ -d "$BACKUP" ]; then
  echo "[1/7] backup already exists — skipping"
else
  echo "[1/7] backing up app..."
  cp -R "$APP" "$BACKUP"
fi

# ── 2. quit the app ──────────────────────────────────────────────
echo "[2/7] quitting DSH Desktop..."
osascript -e 'tell application "DSH Desktop" to quit' >/dev/null 2>&1 || true
for _ in $(seq 1 12); do pgrep -x "DSH Desktop" >/dev/null 2>&1 || break; sleep 1; done
pkill -x "DSH Desktop" >/dev/null 2>&1 || true
sleep 1

# ── 3. build a working tree ──────────────────────────────────────
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ -f "$RES/app/lib/main.js" ] && [ ! -f "$RES/app.asar" ]; then
  echo "[3/7] found an extracted Resources/app — reusing it"
  cp -R "$RES/app/." "$WORK/"
elif [ -f "$RES/app.asar" ]; then
  echo "[3/7] extracting app.asar..."
  npx --yes @electron/asar extract "$RES/app.asar" "$WORK" >/dev/null
  if [ -d "$RES/app.asar.unpacked" ]; then
    cp -R "$RES/app.asar.unpacked/." "$WORK/"
  fi
else
  echo "ERROR: unrecognized app layout (no app.asar and no Resources/app)"; exit 1
fi

# ── 4. patch lib/main.js (idempotent) ────────────────────────────
echo "[4/7] patching lib/main.js..."
python3 - "$WORK/lib/main.js" <<'PYEOF'
import sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()

if "dsh-audio-visualizer patch" in src:
    print("      patch already present — skipping")
    sys.exit(0)

old_import = 'import { BrowserWindow, app, crashReporter, safeStorage, screen, shell } from "electron";'
new_import = 'import { BrowserWindow, app, crashReporter, desktopCapturer, safeStorage, screen, session, shell } from "electron";'
if src.count(old_import) != 1:
    print("ERROR: electron import anchor not found — app version may differ; please open an issue with your app version")
    sys.exit(1)
src = src.replace(old_import, new_import)

anchor = "//#region src/crash-evidence.ts"
if src.count(anchor) != 1:
    print("ERROR: insert anchor not found — app version may differ; please open an issue with your app version")
    sys.exit(1)

block = '''//#region dsh-audio-visualizer patch (local)
// Grants every renderer session the system-output loopback audio for
// getDisplayMedia() (Core Audio taps / "Catap" pick-up), so the audio-visualizer
// plugin can run its AnalyserNode on the system mix. Audio stays in-process.
// NOTE: the main UI lives in a dedicated partition ("dsh-desktop-renderer"),
// so the handler must be installed per-webContents session, not just default.
if (process.platform === "darwin") {
\tapp.commandLine.appendSwitch("enable-features", "MacCatapLoopbackAudioForScreenShare");
\tconst installLoopback = (targetSession) => {
\t\ttry {
\t\t\ttargetSession.setDisplayMediaRequestHandler((_request, callback) => {
\t\t\t\t// All failure paths must be swallowed: this app runs a fail-loud
\t\t\t\t// handler that turns unhandled rejections into a fatal exit.
\t\t\t\tconst safeCallback = (payload) => {
\t\t\t\t\ttry {
\t\t\t\t\t\tcallback(payload);
\t\t\t\t\t} catch {}
\t\t\t\t};
\t\t\t\tdesktopCapturer.getSources({ types: ["screen"] }).then(
\t\t\t\t\t(sources) => {
\t\t\t\t\t\tif (sources && sources.length > 0) {
\t\t\t\t\t\t\tsafeCallback({ video: sources[0], audio: "loopback" });
\t\t\t\t\t\t} else {
\t\t\t\t\t\t\tsafeCallback({ audio: "loopback" });
\t\t\t\t\t\t}
\t\t\t\t\t},
\t\t\t\t\t() => {
\t\t\t\t\t\tsafeCallback({ audio: "loopback" });
\t\t\t\t\t}
\t\t\t\t);
\t\t\t}, { useSystemPicker: false });
\t\t} catch {}
\t};
\tvoid app.whenReady().then(() => {
\t\tinstallLoopback(session.defaultSession);
\t});
\tapp.on("web-contents-created", (_event, contents) => {
\t\ttry {
\t\t\tinstallLoopback(contents.session);
\t\t} catch {}
\t});
}
//#endregion
'''

src = src.replace(anchor, block + anchor, 1)
open(path, "w", encoding="utf-8").write(src)
print("      patch applied")
PYEOF

node --check "$WORK/lib/main.js" >/dev/null 2>&1 || { echo "ERROR: patched main.js failed syntax check"; exit 1; }

# ── 5. deploy as a directory bundle ──────────────────────────────
echo "[5/7] deploying (app.asar -> app.asar.disabled, directory bundle in place)..."
if [ -f "$RES/app.asar" ]; then
  mv "$RES/app.asar" "$RES/app.asar.disabled"
fi
rm -rf "$RES/app"
cp -R "$WORK" "$RES/app"

# ── 6. re-sign ───────────────────────────────────────────────────
echo "[6/7] re-signing (ad-hoc, preserving identifier/entitlements/flags)..."
codesign --force --deep --sign - --preserve-metadata=identifier,entitlements,flags "$APP"
codesign -v --deep --strict "$APP" && echo "      signature verified"

# ── 7. permission steps + launch ─────────────────────────────────
echo "[7/7] done."
cat <<'EOF'

────────────────────────────────────────────────────────────────
NEXT (one time):
  1. System Settings -> Privacy & Security -> Screen Recording
     -> enable DSH Desktop (you will be asked for your password)
  2. Same page -> Audio Capture (if present) -> enable DSH Desktop
  3. Launch DSH Desktop again.

The visualizer will then start automatically with the app.
(Rollback: delete the app and copy the backup from your home folder.)
────────────────────────────────────────────────────────────────
EOF

open -a "DSH Desktop" || true
