'use strict';

// End-to-end smoke test: boots the real app with Playwright's Electron
// driver and verifies the security posture and wrapper behavior that unit
// tests can't cover. Needs a display; on a headless Linux box run:
//
//   xvfb-run -a node scripts/smoke.js
//
// Sandbox note: the Chromium sandbox can't run as root in containers, so we
// pass --no-sandbox to the *test* launch only. The packaged app never
// disables the sandbox.

const path = require('path');
const assert = require('node:assert/strict');
const { _electron } = require('playwright-core');

const ROOT = path.join(__dirname, '..');

const EXPECTED_UA_PARTS = ['Edg/', 'Chrome/', 'Macintosh'];

async function main() {
  const app = await _electron.launch({
    args: ['.', '--no-sandbox'],
    cwd: ROOT
  });

  const results = [];
  const check = (name, ok, extra = '') => {
    results.push({ name, ok, extra });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  };

  try {
    // Window appears.
    const page = await app.firstWindow({ timeout: 30000 });
    check('main window created', true);

    // Where did we land? Real site if network allows, otherwise our local
    // error page. Chromium's own error page would mean our did-fail-load
    // handling is broken.
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    // Give a possible did-fail-load -> error page redirect time to settle.
    await page.waitForTimeout(4000);
    const url = page.url();
    const onSite = url.startsWith('https://www.xbox.com/');
    const onErrorPage = url.startsWith('file://') && url.includes('error.html');
    check('lands on xbox.com or local retry page (never chrome-error)', onSite || onErrorPage, url);

    // Main-process invariants.
    const mainState = await app.evaluate(({ BrowserWindow, session, Menu, powerSaveBlocker }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const ses = session.fromPartition('persist:xcloud');
      return {
        sameSession: win.webContents.session === ses,
        persistent: ses.isPersistent(),
        ua: ses.getUserAgent(),
        hasMenu: !!Menu.getApplicationMenu(),
        windowCount: BrowserWindow.getAllWindows().length
      };
    });
    check('uses persist:xcloud session', mainState.sameSession && mainState.persistent);
    check(
      'session UA is desktop Edge on macOS, not Electron',
      EXPECTED_UA_PARTS.every((p) => mainState.ua.includes(p)) && !mainState.ua.includes('Electron'),
      mainState.ua
    );
    check('application menu installed', mainState.hasMenu);
    check('exactly one window', mainState.windowCount === 1);

    // Renderer-side invariants.
    const rendererState = await page.evaluate(() => ({
      ua: navigator.userAgent,
      webdriver: navigator.webdriver,
      nodeExposed: typeof process !== 'undefined' || typeof require !== 'undefined',
      bridge: typeof window.xcloudHost === 'object' && typeof window.xcloudHost.retry === 'function',
      webrtc: typeof RTCPeerConnection === 'function',
      gum: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      eme: typeof navigator.requestMediaKeySystemAccess === 'function',
      gamepads: typeof navigator.getGamepads === 'function'
    }));
    check('renderer UA masked', !rendererState.ua.includes('Electron'), rendererState.ua);
    check(
      'navigator.webdriver is false',
      rendererState.webdriver === false || rendererState.webdriver === undefined,
      `webdriver=${String(rendererState.webdriver)} (Playwright launches with --remote-debugging; a plain launch has no automation flag at all)`
    );
    check('no Node globals in page (sandbox + contextIsolation)', !rendererState.nodeExposed);
    check('contextBridge API exposed', rendererState.bridge);
    check('WebRTC available', rendererState.webrtc);
    check('getUserMedia available', rendererState.gum);
    check('EME available', rendererState.eme);
    check('Gamepad API available', rendererState.gamepads);

    // Preload -> main IPC round trip with sender validation.
    const version = await page.evaluate(() => window.xcloudHost.getVersion());
    check('IPC round trip (getVersion)', typeof version === 'string' && version.length > 0, version);

    // If we're on the error page, the retry UI must be present.
    if (onErrorPage) {
      const hasRetry = await page.evaluate(() => !!document.getElementById('retry'));
      check('error page shows retry button', hasRetry);
    }

    // window.open to a non-allowlisted host must not create a window.
    await page.evaluate(() => window.open('https://example.com/', '_blank'));
    await page.waitForTimeout(1500);
    const windowsAfterOpen = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    check('window.open to external host denied', windowsAfterOpen === 1);
  } finally {
    await app.close().catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  assert.equal(failed.length, 0, `failed: ${failed.map((f) => f.name).join(', ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
