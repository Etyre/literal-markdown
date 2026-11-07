'use strict';
// Literal: the Electron main process of a WYSIWYG Markdown editor that never hides or rewrites
// a line (the editor itself is src/renderer.js). This file owns windows, the menu, file I/O,
// dialogs and file watching, and remembers every open window across launches.
//
// Config/state: ~/Library/Application Support/literal-markdown/state.json (windows, files,
// folders, sidebar, Rendered/Raw). The Find-panel draft is in the renderer's localStorage under
// the same folder. There is no log file: this is a foreground app, errors show in the window
// or in View > Toggle Developer Tools. The installed copy is /Applications/Literal.app.
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');

// Every window is an independent document: its own file, folder tree, dirty flag and
// file watcher. `windows` maps each BrowserWindow to that record. The saved state lists
// every open window so all of them come back on the next launch.
const windows = new Map();   // BrowserWindow -> { state, dirty, watcher, closeAfterSave, quitAfterClose }
let globalRaw = false;       // Rendered / Raw is one preference shared by all windows
let quitting = false;
let pendingOpenPaths = [];   // files macOS asked us to open before the app was ready

const recOf = (sender) => windows.get(BrowserWindow.fromWebContents(sender));
const winOf = (sender) => BrowserWindow.fromWebContents(sender);
const focusedWindow = () => BrowserWindow.getFocusedWindow() || [...windows.keys()][0] || null;

// ---------- persisted state ----------
const statePath = () => path.join(app.getPath('userData'), 'state.json');
function loadState() {
  let st = {};
  try { st = JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch {}
  // Older versions saved a single window at the top level.
  if (!Array.isArray(st.windows)) {
    const { file, folder, expanded, sidebarHidden } = st;
    st.windows = file || folder ? [{ file, folder, expanded, sidebarHidden }] : [];
  }
  return st;
}
let persistTimer = null;
function persist() {
  if (quitting) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 200);
}
function persistNow() {
  clearTimeout(persistTimer);
  // Never write an empty window list: the last window's state is what the next launch restores.
  if (!windows.size) return;
  const st = { raw: globalRaw, windows: [...windows.values()].map((r) => r.state) };
  try { fs.writeFileSync(statePath(), JSON.stringify(st)); } catch {}
}

// ---------- windows ----------
function createWindow(initial = {}) {
  const state = { file: null, folder: null, expanded: [], sidebarHidden: false, ...initial };
  // A new window opens offset from the focused one so it is obviously a second window.
  let bounds = state.bounds;
  if (!bounds) {
    const ref = focusedWindow();
    bounds = ref ? { ...ref.getBounds() } : { width: 1180, height: 820 };
    if (ref) { bounds.x += 28; bounds.y += 28; }
  }
  const screenshot = process.argv.find((a) => a.startsWith('--screenshot='));
  const win = new BrowserWindow({
    ...bounds,
    show: !screenshot,   // the screenshot aid shows the window without taking focus from whatever is being typed
    minWidth: 600,
    minHeight: 400,
    title: 'Literal',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const rec = { state, dirty: false, watcher: null, closeAfterSave: false, quitAfterClose: false, pendingOpen: null };
  windows.set(win, rec);
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  win.webContents.on('did-finish-load', () => {
    if (rec.pendingOpen) { win.webContents.send('open-path', rec.pendingOpen); rec.pendingOpen = null; }
    // Development aid: `electron . file.md --screenshot=out.png` captures the window and quits.
    if (screenshot) {
      win.showInactive();
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(screenshot.slice('--screenshot='.length), img.toPNG());
        for (const r of windows.values()) r.dirty = false;
        app.quit();
      }, 1500);
    }
  });

  // Links in the editor open in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  let boundsTimer = null;
  const saveBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => { if (!win.isDestroyed()) { rec.state.bounds = win.getBounds(); persist(); } }, 300);
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  win.on('close', (e) => {
    // Closing the last window quits the app; snapshot it while it still counts.
    if (!quitting && windows.size === 1) persistNow();
    if (!rec.dirty) return;
    e.preventDefault();
    const wasQuitting = quitting;
    quitting = false;   // a prevented close cancels the quit; we restart it below if the user didn't cancel
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: `${path.basename(rec.state.file || 'Untitled')} has unsaved changes.`,
      detail: 'Save before closing?',
    });
    if (choice === 0) {
      rec.closeAfterSave = true;
      rec.quitAfterClose = wasQuitting;
      win.webContents.send('menu', 'save');
    } else if (choice === 1) {
      rec.dirty = false;
      win.destroy();
      if (wasQuitting) app.quit();
    }
  });
  win.on('closed', () => {
    stopWatching(rec);
    windows.delete(win);
    if (!quitting && windows.size > 0) persist();
    else clearTimeout(persistTimer);
  });
  return win;
}

// Open a file the way macOS expects: focus the window that already shows it, reuse an
// empty untouched window, otherwise open a new window.
function openPath(file) {
  for (const [w, r] of windows) if (r.state.file === file) { w.focus(); return w; }
  const focused = focusedWindow();
  const rec = focused && windows.get(focused);
  if (rec && !rec.state.file && !rec.dirty) {
    if (focused.webContents.isLoading()) rec.pendingOpen = file;
    else focused.webContents.send('open-path', file);
    focused.focus();
    return focused;
  }
  return createWindow({ file });
}

// A fresh window that shows the same folder as the window it was opened from.
function newWindow(extra = {}) {
  const focused = focusedWindow();
  const from = focused ? windows.get(focused).state : {};
  return createWindow({ folder: from.folder, expanded: from.expanded, sidebarHidden: from.sidebarHidden, ...extra });
}

// ---------- menu ----------
function send(cmd) { const w = focusedWindow(); if (w) w.webContents.send('menu', cmd); }
function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' }, { type: 'separator' },
        { role: 'services' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => newWindow() },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        { label: 'Open Folder…', accelerator: 'Shift+CmdOrCtrl+O', click: () => send('open-folder') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: 'Save As…', accelerator: 'Shift+CmdOrCtrl+S', click: () => send('save-as') },
        { type: 'separator' },
        { label: 'Reveal in Finder', click: () => send('reveal') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: () => send('redo') },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => send('find') },
        { type: 'separator' },
        { label: 'Bold', accelerator: 'CmdOrCtrl+B', click: () => send('bold') },
        { label: 'Italic', accelerator: 'CmdOrCtrl+I', click: () => send('italic') },
        { label: 'Toggle Bullet', accelerator: 'Shift+CmdOrCtrl+8', click: () => send('bullet') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+\\', click: () => send('toggle-sidebar') },
        { label: 'Toggle Rendered / Raw', accelerator: 'CmdOrCtrl+/', click: () => send('toggle-raw') },
        { type: 'separator' },
        { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- file watching (reload when the file changes on disk and the window is clean) ----------
function stopWatching(rec) { if (rec.watcher) { rec.watcher.close(); rec.watcher = null; } }
// The folder is watched rather than the file itself, so a program that saves by writing a
// temporary file and renaming it over the original is noticed too.
function watchFile(win, rec, file) {
  stopWatching(rec);
  if (!file) return;
  try {
    let timer = null;
    const name = path.basename(file);
    rec.watcher = fs.watch(path.dirname(file), (_ev, changed) => {
      if (changed && changed !== name) return;
      clearTimeout(timer);
      timer = setTimeout(() => { if (!win.isDestroyed()) win.webContents.send('file-changed', file); }, 150);
    });
  } catch {}
}

// ---------- ipc ----------
// One level of a folder: its subfolders and files, each sorted by name. The sidebar
// asks for deeper levels only when a folder is expanded, so large trees stay cheap.
const SKIP_DIRS = new Set(['node_modules', 'venv', '.venv', '__pycache__']);
function listDir(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { dirs: [], files: [] }; }
  const dirs = [], files = [];
  for (const ent of entries) {
    if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    let isDir = ent.isDirectory();
    if (ent.isSymbolicLink()) { try { isDir = fs.statSync(full).isDirectory(); } catch { continue; } }
    (isDir ? dirs : files).push({ name: ent.name, path: full });
  }
  const cmp = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  dirs.sort(cmp); files.sort(cmp);
  return { dirs, files };
}

// 'text' if the file can be opened in the editor, otherwise why not.
function probeFile(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return 'missing';
    if (st.size > 20 * 1024 * 1024) return 'large';
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return 'binary';
    return 'text';
  } catch { return 'missing'; }
}

ipcMain.handle('read-file', (_e, file) => fs.readFileSync(file, 'utf8'));
ipcMain.handle('write-file', (_e, file, text) => { fs.writeFileSync(file, text, 'utf8'); return true; });
ipcMain.handle('list-folder', (_e, folder) => listDir(folder));
ipcMain.handle('probe-file', (_e, file) => probeFile(file));
ipcMain.handle('open-path', (_e, file) => shell.openPath(file));
ipcMain.handle('open-new-window', (_e, file) => { newWindow({ file }); });
ipcMain.handle('get-state', (e) => { const rec = recOf(e.sender); return { ...(rec ? rec.state : {}), raw: globalRaw }; });
ipcMain.handle('set-state', (e, patch) => {
  const { raw, ...rest } = patch;
  if (raw !== undefined) globalRaw = !!raw;
  const rec = recOf(e.sender);
  if (rec) Object.assign(rec.state, rest);
  persist();
});
ipcMain.handle('set-dirty', (e, isDirty, file) => {
  const win = winOf(e.sender), rec = windows.get(win);
  if (!rec) return;
  rec.dirty = !!isDirty;
  win.setDocumentEdited(rec.dirty);
  if (file) win.setRepresentedFilename(file);
});
ipcMain.handle('watch-file', (e, file) => { const win = winOf(e.sender), rec = windows.get(win); if (rec) watchFile(win, rec, file); });
ipcMain.on('saved', (e) => {
  const win = winOf(e.sender), rec = windows.get(win);
  if (!rec || !rec.closeAfterSave) return;
  rec.closeAfterSave = false; rec.dirty = false;
  win.destroy();
  if (rec.quitAfterClose) app.quit();
});
ipcMain.on('save-cancelled', (e) => { const rec = recOf(e.sender); if (rec) { rec.closeAfterSave = false; rec.quitAfterClose = false; } });
ipcMain.handle('reveal', (_e, file) => { if (file) shell.showItemInFolder(file); });
ipcMain.handle('open-external', (_e, url) => shell.openExternal(url));
ipcMain.handle('dialog-open-file', async (e) => {
  const r = await dialog.showOpenDialog(winOf(e.sender), { properties: ['openFile'], filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }, { name: 'All Files', extensions: ['*'] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog-open-folder', async (e) => {
  const r = await dialog.showOpenDialog(winOf(e.sender), { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog-save-as', async (e, defaultPath) => {
  const r = await dialog.showSaveDialog(winOf(e.sender), { defaultPath, filters: [{ name: 'Markdown', extensions: ['md'] }] });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('confirm-discard', (e) => {
  const choice = dialog.showMessageBoxSync(winOf(e.sender), {
    type: 'warning', buttons: ['Discard Changes', 'Cancel'], defaultId: 1, cancelId: 1,
    message: 'This file has unsaved changes.', detail: 'Discard them and switch files?',
  });
  return choice === 0;
});

// ---------- app lifecycle ----------
app.on('open-file', (e, file) => {
  e.preventDefault();
  if (app.isReady() && windows.size) openPath(file);
  else pendingOpenPaths.push(file);
});

app.whenReady().then(() => {
  buildMenu();
  const st = loadState();
  globalRaw = !!st.raw;
  const arg = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-'));
  if (arg) pendingOpenPaths.push(path.resolve(arg));
  // Every window from last time comes back; files asked for at launch go to their own window
  // unless one of the restored windows already shows them.
  for (const w of st.windows) createWindow(w);
  for (const file of pendingOpenPaths) {
    if (![...windows.values()].some((r) => r.state.file === file)) createWindow({ file });
    else openPath(file);
  }
  pendingOpenPaths = [];
  if (!windows.size) createWindow();
  app.on('activate', () => { if (!windows.size) createWindow(loadState().windows[0] || {}); });
});

app.on('before-quit', () => { persistNow(); quitting = true; });
app.on('window-all-closed', () => { app.quit(); });
