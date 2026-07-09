'use strict';

// Preload for every window (main window, auth popups, local error page).
// Runs sandboxed with contextIsolation — the page can only reach the
// functions exposed here, and every IPC channel is re-validated in the main
// process against the sender frame's origin.
//
// Note on navigator.webdriver: with contextIsolation this script lives in an
// isolated world and cannot redefine properties on the page's `navigator`.
// The override is therefore done in the main process via
// `--disable-blink-features=AutomationControlled`, which makes the page see
// navigator.webdriver === false before any site script runs.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xcloudHost', {
  toggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
  isFullscreen: () => ipcRenderer.invoke('window:is-fullscreen'),
  retry: () => ipcRenderer.invoke('app:retry'),
  getVersion: () => ipcRenderer.invoke('app:get-version')
});
