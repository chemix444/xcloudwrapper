'use strict';

const { Menu, app } = require('electron');

// Minimal macOS menu: no File menu (nothing like "New Window" applies), a
// trimmed Edit menu (login forms still need paste/undo for muscle memory and
// password managers), View with reload + the standard Cmd+Ctrl+F fullscreen
// toggle, and a standard Window menu so Cmd+W/Cmd+M/Cmd+H keep working.
// Cmd+W and Cmd+Q stay bound — the close guard in main.js prompts if a
// stream is active.

function buildMenu({ reload, goHome, openExternal }) {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ]
      : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => reload()
        },
        {
          label: 'Back to Xbox Home',
          accelerator: 'CmdOrCtrl+Shift+H',
          click: () => goHome()
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged
          ? []
          : [{ type: 'separator' }, { role: 'toggleDevTools' }])
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [])
      ]
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Project on GitHub',
          click: () => openExternal('https://github.com/chemix444/xcloudwrapper')
        }
      ]
    }
  ];

  return Menu.buildFromTemplate(template);
}

module.exports = { buildMenu };
