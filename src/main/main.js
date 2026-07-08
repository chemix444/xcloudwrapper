'use strict';

const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  powerSaveBlocker,
  session,
  shell,
  systemPreferences
} = require('electron');
const path = require('path');
const windowStateKeeper = require('electron-window-state');

const {
  PLAY_HOME_URL,
  isInternalUrl,
  isAuthPopupUrl,
  isSafeExternalUrl,
  isStreamUrl,
  resolveDeepLink
} = require('./urls');
const { buildMenu } = require('./menu');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Persistent partition: login cookies and MSA refresh tokens survive
// restarts. Never swap this for an in-memory partition.
const PARTITION = 'persist:xcloud';

// xbox.com/play gates features on user agent. Present as current desktop
// Edge on macOS instead of Electron's default UA (which includes
// "Electron/x.y" and can be blocked or served a degraded experience).
// Chromium >= 110 freezes the OS token at "10_15_7", so this stays valid.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0';

const PRELOAD_PATH = path.join(__dirname, '..', 'preload', 'preload.js');
const ERROR_PAGE = 'src/renderer/error.html';

// Renderer permissions we grant to trusted origins. Everything else is
// denied. 'media' (mic) is for party/voice chat; pointerLock and
// keyboardLock are required by keyboard+mouse games; fullscreen for the
// in-player fullscreen button. EME ('mediaKeySystem') is left enabled even
// though xCloud streams over WebRTC and does not need Widevine — we simply
// never bundle a CDM.
const ALLOWED_PERMISSIONS = new Set([
  'media',
  'fullscreen',
  'pointerLock',
  'keyboardLock',
  'clipboard-sanitized-write',
  'mediaKeySystem'
]);

// ---------------------------------------------------------------------------
// Chromium flags — set before app ready. Keep this list short and justified.
// ---------------------------------------------------------------------------

// Makes navigator.webdriver === false. Some streaming/anti-automation checks
// probe it. (With contextIsolation the preload runs in an isolated world and
// cannot redefine the page's `navigator`, so this switch — not script
// injection — is the reliable mechanism.)
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

// Belt-and-braces companions to backgroundThrottling:false so the WebRTC
// stream is never deprioritized when the window is occluded or unfocused.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// NOTE deliberately absent: no flags touching WebRTC, EME, or GPU. xCloud
// needs getUserMedia/RTCPeerConnection working stock, and no Widevine CDM.

// Apply the UA fallback early so every context (service workers included)
// reports the same string.
app.userAgentFallback = USER_AGENT;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let mainWindow = null;
let targetUrl = PLAY_HOME_URL; // last good xbox.com URL; used by retry/reload
let mediaPlaying = false;
let sleepBlockerId = null;
let bypassCloseGuard = false;
let quitRequested = false;
let unresponsiveDialogOpen = false;

// ---------------------------------------------------------------------------
// Single instance + deep links (CLI arg, xcloud:// protocol)
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  bootstrap();
}

function firstDeepLinkIn(argv) {
  for (const arg of argv) {
    const url = resolveDeepLink(arg);
    if (url) return url;
  }
  return null;
}

function bootstrap() {
  app.setName('XCloud Player');
  app.setAsDefaultProtocolClient('xcloud');

  const argvLink = firstDeepLinkIn(process.argv.slice(1));
  if (argvLink) targetUrl = argvLink;

  // macOS delivers xcloud:// links here (not via argv). If no window exists
  // yet (before ready, or reopened later via 'activate'), the next window
  // creation picks targetUrl up.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    const resolved = resolveDeepLink(url);
    if (!resolved) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      loadTarget(resolved);
      focusMainWindow();
    } else {
      targetUrl = resolved;
    }
  });

  app.on('second-instance', (_event, argv) => {
    const url = firstDeepLinkIn(argv.slice(1));
    if (url) loadTarget(url);
    focusMainWindow();
  });

  app.on('before-quit', () => {
    quitRequested = true;
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
    else focusMainWindow();
  });

  app.whenReady().then(() => {
    configureSession(session.fromPartition(PARTITION));
    registerIpc();
    Menu.setApplicationMenu(
      buildMenu({
        reload: () => reloadCurrent(),
        goHome: () => loadTarget(PLAY_HOME_URL),
        openExternal: (url) => shell.openExternal(url)
      })
    );
    createMainWindow();
  });
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------------------------------------------------------------------------
// Session hardening
// ---------------------------------------------------------------------------

function configureSession(ses) {
  ses.setUserAgent(USER_AGENT);

  // Permission gating: trusted origins get the allowlisted permissions,
  // everything else is denied. Microphone additionally goes through the
  // macOS TCC prompt; camera is always denied (xCloud never needs it).
  ses.setPermissionRequestHandler(async (webContents, permission, callback, details) => {
    const origin = details.requestingUrl || (webContents ? webContents.getURL() : '');
    if (!isInternalUrl(origin) || !ALLOWED_PERMISSIONS.has(permission)) {
      return callback(false);
    }
    if (permission === 'media') {
      const types = details.mediaTypes || [];
      if (types.includes('video')) return callback(false);
      if (types.includes('audio') && process.platform === 'darwin') {
        try {
          const granted = await systemPreferences.askForMediaAccess('microphone');
          if (!granted) return callback(false);
        } catch {
          return callback(false);
        }
      }
    }
    callback(true);
  });

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return isInternalUrl(requestingOrigin) && ALLOWED_PERMISSIONS.has(permission);
  });

  // No webRequest handlers on purpose: Xbox auth/session API calls must pass
  // through untouched — rewriting headers there breaks login. No display
  // media handler either, so getDisplayMedia() is refused by default.
}

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

function secureWebPreferences() {
  return {
    partition: PARTITION,
    preload: PRELOAD_PATH,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    sandbox: true,
    webviewTag: false,
    // Never throttle timers/rendering when unfocused or occluded — a
    // backgrounded window must keep the stream running at full rate.
    backgroundThrottling: false,
    spellcheck: false,
    devTools: !app.isPackaged
  };
}

function createMainWindow() {
  // Persist size, position, display, maximize and fullscreen state across
  // launches; electron-window-state also validates saved bounds against the
  // current display layout (multi-monitor safe).
  const windowState = windowStateKeeper({
    defaultWidth: 1280,
    defaultHeight: 800
  });

  const win = new BrowserWindow({
    x: windowState.x,
    y: windowState.y,
    width: windowState.width,
    height: windowState.height,
    minWidth: 640,
    minHeight: 400,
    title: 'XCloud Player',
    backgroundColor: '#0e1113',
    show: false,
    fullscreenable: true,
    webPreferences: secureWebPreferences()
  });

  mainWindow = win;
  windowState.manage(win);
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });

  attachNavigationPolicy(win.webContents);
  attachFullscreenSync(win);
  attachStreamLifecycle(win);
  attachFailureHandling(win);
  attachCloseGuard(win);

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    bypassCloseGuard = false;
    updateSleepBlocker();
  });

  loadTarget(targetUrl);
}

function loadTarget(url) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!isInternalUrl(url)) url = PLAY_HOME_URL;
  targetUrl = url;
  mainWindow.loadURL(url, { userAgent: USER_AGENT }).catch(() => {
    // did-fail-load handles the visible error state.
  });
}

function reloadCurrent() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const current = mainWindow.webContents.getURL() || '';
  // If we're sitting on the local error page, "reload" means retry the last
  // real destination, not reload the error page itself.
  if (current.startsWith('file:')) loadTarget(targetUrl);
  else mainWindow.webContents.reload();
}

// ---------------------------------------------------------------------------
// Navigation policy: keep xbox.com + MS auth inside, everything else outside.
// Login popups (window.open from Microsoft OAuth) become child windows that
// share the persistent session, instead of external tabs or untracked
// Electron windows.
// ---------------------------------------------------------------------------

function attachNavigationPolicy(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    if (isAuthPopupUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
          width: 480,
          height: 680,
          autoHideMenuBar: true,
          backgroundColor: '#0e1113',
          webPreferences: secureWebPreferences()
        }
      };
    }
    if (isInternalUrl(url)) {
      // Same-site target=_blank: keep it in the main window.
      loadTarget(url);
      return { action: 'deny' };
    }
    if (isSafeExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  wc.on('did-create-window', (child) => {
    // Auth popups get the same policy so a compromised/lost flow can't wander.
    attachNavigationPolicy(child.webContents);
    // A login popup that can't load is useless — close it rather than show
    // Chromium's default error page; the user retries from the site.
    child.webContents.on('did-fail-load', (_e, errorCode, _desc, _url, isMainFrame) => {
      if (isMainFrame && errorCode !== -3 && !child.isDestroyed()) child.close();
    });
  });

  wc.on('will-navigate', (event, url) => {
    if (isInternalUrl(url)) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) shell.openExternal(url);
  });

  wc.on('did-navigate', (_event, url) => {
    if (isInternalUrl(url)) targetUrl = url;
    // New document: any previous media state is gone.
    mediaPlaying = false;
    updateSleepBlocker();
  });

  wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame && isInternalUrl(url)) targetUrl = url;
  });
}

// ---------------------------------------------------------------------------
// Fullscreen: macOS native fullscreen (green light / Cmd+Ctrl+F) and the
// site's own HTML fullscreen requests must not fight. The stuck state to
// prevent: user leaves native fullscreen while the page still believes it is
// element-fullscreen — so on every native leave, tell the page to exit too.
// ---------------------------------------------------------------------------

function attachFullscreenSync(win) {
  win.on('leave-full-screen', () => {
    const wc = win.webContents;
    if (wc.isDestroyed()) return;
    wc.executeJavaScript(
      'if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); }',
      true
    ).catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// Stream lifecycle: display sleep prevention + quit guard heuristics.
//
// "Streaming" signals available to the main process without injecting into
// Xbox's page:
//   - URL matches /play/launch/... (the stream/launch surface)
//   - webContents media playback events (the stream's <video> element)
// ---------------------------------------------------------------------------

function isOnStreamPage() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  return isStreamUrl(mainWindow.webContents.getURL() || '');
}

function updateSleepBlocker() {
  const win = mainWindow;
  const active = !!win && !win.isDestroyed() && (mediaPlaying || isOnStreamPage());
  // Release when the app is backgrounded (hidden/minimized) or closed; keep
  // it while the window is merely unfocused — the stream is still visible.
  const visible = !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
  const shouldBlock = active && visible;

  if (shouldBlock && sleepBlockerId === null) {
    sleepBlockerId = powerSaveBlocker.start('prevent-display-sleep');
  } else if (!shouldBlock && sleepBlockerId !== null) {
    if (powerSaveBlocker.isStarted(sleepBlockerId)) powerSaveBlocker.stop(sleepBlockerId);
    sleepBlockerId = null;
  }
}

function attachStreamLifecycle(win) {
  const wc = win.webContents;
  wc.on('media-started-playing', () => {
    mediaPlaying = true;
    updateSleepBlocker();
  });
  wc.on('media-paused', () => {
    mediaPlaying = false;
    updateSleepBlocker();
  });
  for (const ev of ['minimize', 'restore', 'hide', 'show']) {
    win.on(ev, updateSleepBlocker);
  }
}

// ---------------------------------------------------------------------------
// Quit/close guard: a stray Cmd+Q or Cmd+W must not kill a live session.
// Electron routes Cmd+Q through before-quit -> window close, so guarding
// 'close' covers both; preventing the close aborts the quit.
// ---------------------------------------------------------------------------

function attachCloseGuard(win) {
  win.on('close', (event) => {
    if (bypassCloseGuard || !isOnStreamPage()) return;
    event.preventDefault();
    const wasQuit = quitRequested;
    quitRequested = false; // the prevented close cancelled the quit

    dialog
      .showMessageBox(win, {
        type: 'warning',
        buttons: [wasQuit ? 'End Session and Quit' : 'End Session and Close', 'Keep Playing'],
        defaultId: 1,
        cancelId: 1,
        message: 'A game stream is active.',
        detail: wasQuit
          ? 'Quitting will end your Xbox Cloud Gaming session.'
          : 'Closing this window will end your Xbox Cloud Gaming session.'
      })
      .then(({ response }) => {
        if (response !== 0 || win.isDestroyed()) return;
        bypassCloseGuard = true;
        if (wasQuit) app.quit();
        else win.close();
      });
  });
}

// ---------------------------------------------------------------------------
// Failure handling: never show Chromium's default error page. Navigation
// errors get a local retry page; renderer crashes reload the stream target.
// ---------------------------------------------------------------------------

function attachFailureHandling(win) {
  const wc = win.webContents;

  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 (ERR_ABORTED) fires for cancelled navigations, including normal
    // SPA behavior — not an error.
    if (!isMainFrame || errorCode === -3) return;
    if (isInternalUrl(validatedURL)) targetUrl = validatedURL;
    if (win.isDestroyed()) return;
    win
      .loadFile(ERROR_PAGE, {
        query: {
          code: String(errorCode),
          description: errorDescription || 'Navigation failed',
          url: validatedURL || targetUrl
        }
      })
      .catch(() => {});
  });

  wc.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit' || win.isDestroyed()) return;
    mediaPlaying = false;
    updateSleepBlocker();
    loadTarget(targetUrl);
  });

  wc.on('unresponsive', () => {
    if (win.isDestroyed() || unresponsiveDialogOpen) return;
    unresponsiveDialogOpen = true;
    dialog
      .showMessageBox(win, {
        type: 'warning',
        buttons: ['Wait', 'Reload'],
        defaultId: 0,
        cancelId: 0,
        message: 'Xbox Cloud Gaming is not responding.'
      })
      .then(({ response }) => {
        unresponsiveDialogOpen = false;
        if (response === 1 && !win.isDestroyed()) loadTarget(targetUrl);
      });
  });
}

// ---------------------------------------------------------------------------
// IPC — the only renderer->main surface, exposed via contextBridge in the
// preload. Every handler validates the sender frame.
// ---------------------------------------------------------------------------

function isTrustedSender(event) {
  const frameUrl = (event.senderFrame && event.senderFrame.url) || '';
  if (isInternalUrl(frameUrl)) return true;
  // Our local error page (file://.../src/renderer/error.html).
  try {
    const u = new URL(frameUrl);
    return u.protocol === 'file:' && u.pathname.endsWith('/src/renderer/error.html');
  } catch {
    return false;
  }
}

function registerIpc() {
  ipcMain.handle('window:toggle-fullscreen', (event) => {
    if (!isTrustedSender(event)) return false;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;
    win.setFullScreen(!win.isFullScreen());
    return win.isFullScreen();
  });

  ipcMain.handle('window:is-fullscreen', (event) => {
    if (!isTrustedSender(event)) return false;
    const win = BrowserWindow.fromWebContents(event.sender);
    return !!win && !win.isDestroyed() && win.isFullScreen();
  });

  ipcMain.handle('app:retry', (event) => {
    if (!isTrustedSender(event)) return;
    loadTarget(targetUrl);
  });

  ipcMain.handle('app:get-version', (event) => {
    if (!isTrustedSender(event)) return '';
    return app.getVersion();
  });
}
