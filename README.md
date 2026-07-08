# XCloud Player

A production-quality macOS desktop wrapper for [Xbox Cloud Gaming](https://www.xbox.com/play),
built on Electron. It hosts `xbox.com/play` in a hardened, native-feeling window and stays
out of the way: no custom chrome around the player, no telemetry, no third-party pings.
Electron's job here is host and plumbing, not reskinning Xbox's UI.

Universal binary (Apple Silicon + Intel) via a single electron-builder target.

> Not affiliated with Microsoft. Xbox is a trademark of Microsoft Corporation.

## Quick start

```sh
npm install
npm start                 # run in development
npm test                  # unit tests (URL policy / deep links)
npm run smoke             # end-to-end smoke test (boots the real app; headless: xvfb-run -a npm run smoke)
npm run dist              # signed + notarized universal .dmg/.zip (needs Apple creds, see below)
npm run dist:unsigned     # local unsigned build for your own machine
```

## Layout

```
src/main/main.js        app lifecycle, session, window, guards (the core)
src/main/urls.js        URL policy: allowlists + xcloud:// deep-link parsing (pure, unit-tested)
src/main/menu.js        trimmed macOS menu
src/preload/preload.js  contextBridge API (the only renderer -> main surface)
src/renderer/error.*    local retry page shown instead of Chromium's error page
build/                  entitlements + icon (regenerate: npm run icon)
scripts/smoke.js        boots the app via playwright-core and asserts the invariants below
```

## How each edge case is handled

### Security baseline
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webviewTag: false`
  on every window (main, auth popups, error page). The smoke test asserts no Node globals
  leak into the page.
- All renderer -> main communication goes through `contextBridge` (`window.xcloudHost`) and
  every IPC handler re-validates the sender frame's origin in the main process.
- DevTools are disabled in packaged builds.

### Session & login
- Persistent partition **`persist:xcloud`** — cookies and MSA refresh tokens survive
  restarts, so you log in once. Never an in-memory session.
- **No `webRequest` interception at all.** Xbox auth/session API calls pass through
  untouched; rewriting headers there is what breaks login in most wrappers.
- Microsoft OAuth popups (`window.open` from the page) open as **child windows** sharing
  the same persistent session — never external browser tabs, never untracked windows.
  Full-page redirects to `login.live.com` / `login.microsoftonline.com` etc. are allowed
  in the main window (the login flow uses both shapes).
- Any navigation outside xbox.com/xboxlive.com/Microsoft-auth hosts is denied in-app and
  handed to the default browser (https/mailto only — never `file:` or other schemes).

### Browser identity
- User agent is set (session-wide and as `app.userAgentFallback`) to current **desktop
  Edge on macOS**. Electron's default UA self-identifies as Electron and gets xCloud's
  degraded/blocked experience. Chromium freezes the macOS token at `10_15_7`, so the
  string stays valid; bump the `Chrome/Edg` version in `src/main/main.js` occasionally.
- `navigator.webdriver` is `false` via `--disable-blink-features=AutomationControlled`.
  (With contextIsolation a preload can't redefine the page's `navigator` — the switch is
  the reliable mechanism, applied before any site script runs.)
- WebRTC, `getUserMedia`, EME and the Gamepad API are stock-Chromium enabled — the smoke
  test asserts all four. **No Widevine CDM is bundled**: xCloud streams over WebRTC and
  doesn't need one.

### Input
- **Gamepads:** nothing to do in-app — Chromium's `navigator.getGamepads()` sees any
  controller paired at the OS level. Pair your Xbox Wireless Controller in
  *macOS System Settings → Bluetooth* (not inside any app), then it just works.
- **Keyboard/mouse games:** `pointerLock` and `keyboardLock` permissions are granted to
  xbox.com (and only xbox.com).
- **Cmd+Q / Cmd+W during a stream:** the window `close` event is guarded. If the current
  URL is a stream surface (`/play/launch/...`), closing or quitting first prompts
  ("End Session and Quit / Keep Playing"). Electron routes Cmd+Q through the same window
  close, so one guard covers both, and a prevented close aborts the quit.
- **Cmd+H / Cmd+Tab:** hiding or backgrounding never kills the stream —
  `backgroundThrottling: false` plus `--disable-background-timer-throttling` and
  `--disable-backgrounding-occluded-windows` keep the WebRTC pipeline at full rate when
  the window is unfocused or occluded.

### Window & display
- Window size, position, **display** (multi-monitor), maximize and fullscreen state
  persist across launches via `electron-window-state`, which also validates saved bounds
  against the current monitor layout. Nothing is hardcoded.
- **Fullscreen conflict handling:** macOS native fullscreen (green light / Cmd+Ctrl+F)
  and the site's in-player fullscreen button can desync. The stuck state — window left
  fullscreen-less while the page still thinks it's element-fullscreen — is prevented by
  syncing on every native `leave-full-screen`: the page is told to `exitFullscreen()` too.
- **Display sleep:** a `powerSaveBlocker` (`prevent-display-sleep`) runs while a stream
  is active (media playing or on a `/play/launch` URL) and the window is visible. It is
  released when the app is hidden/minimized or the window closes, so a backgrounded app
  never pins your display awake.

### Reliability
- Navigation failures (offline, DNS, connection reset) show a **local retry page** — never
  Chromium's default error page. It retries on click, automatically when the network
  comes back (`online` event), and every 15 s while up.
- Renderer crashes (`render-process-gone`) reload the last good xbox.com URL.
- An unresponsive page offers Wait / Reload.
- WebRTC session drops mid-stream are surfaced by xCloud's own in-page UI (it has its own
  reconnect flow); the wrapper deliberately doesn't fight it.

### Deep links
Launch straight into a game via CLI arg or the `xcloud://` protocol (registered in
Info.plist by electron-builder and via `setAsDefaultProtocolClient`):

```
xcloud://game/<productId>      ->  https://www.xbox.com/play/launch/<productId>
xcloud://play/<path...>        ->  https://www.xbox.com/play/<path...>
https://www.xbox.com/play/...  ->  passed through as-is
open -a "XCloud Player" xcloud://game/9NBLGGH4V0FL
```

Anything that doesn't strictly match is ignored (segments are validated; dot-segment and
scheme tricks can't escape `xbox.com/play` — see `test/urls.test.js`). Single instance:
a second launch focuses the running app and routes the link to it.

## Packaging, signing, notarization

`npm run dist` builds a **universal** (arm64 + x64) `.dmg` and `.zip` with hardened
runtime. Requires macOS with Xcode command-line tools.

- **Signing:** electron-builder picks up a `Developer ID Application` certificate from
  your keychain automatically.
- **Notarization:** set these env vars and `npm run dist` notarizes as part of the build
  (unsigned/unnotarized builds get Gatekeeper-blocked on other people's machines):

  ```sh
  export APPLE_ID="you@example.com"
  export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # appleid.apple.com -> App-Specific Passwords
  export APPLE_TEAM_ID="XXXXXXXXXX"
  npm run dist
  ```

- **Entitlements** (`build/entitlements.mac.plist`): JIT/unsigned-executable-memory for
  V8, network client/server for the stream, and **microphone** for party chat
  (`NSMicrophoneUsageDescription` is set in Info.plist). Camera is deliberately not
  requested — xCloud never uses it, and camera permission requests are denied in code.
- The app icon is generated from `scripts/generate-icon.js` (`npm run icon`) into
  `build/icon.png`; electron-builder converts it to `.icns`.

## Explicit non-goals

- No Widevine/CDM bundling (not needed for WebRTC streaming).
- No custom UI chrome around the player — the site's own controls render untouched.
- No telemetry, analytics, or auto-update pinging anywhere.
