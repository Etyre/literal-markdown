'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('literal', {
  readFile: (file) => ipcRenderer.invoke('read-file', file),
  writeFile: (file, text) => ipcRenderer.invoke('write-file', file, text),
  listFolder: (folder) => ipcRenderer.invoke('list-folder', folder),
  probeFile: (file) => ipcRenderer.invoke('probe-file', file),
  openPath: (file) => ipcRenderer.invoke('open-path', file),
  openInNewWindow: (file) => ipcRenderer.invoke('open-new-window', file),
  getState: () => ipcRenderer.invoke('get-state'),
  setState: (patch) => ipcRenderer.invoke('set-state', patch),
  setDirty: (dirty, file) => ipcRenderer.invoke('set-dirty', dirty, file),
  watchFile: (file) => ipcRenderer.invoke('watch-file', file),
  reveal: (file) => ipcRenderer.invoke('reveal', file),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openFileDialog: () => ipcRenderer.invoke('dialog-open-file'),
  openFolderDialog: () => ipcRenderer.invoke('dialog-open-folder'),
  saveAsDialog: (defaultPath) => ipcRenderer.invoke('dialog-save-as', defaultPath),
  confirmDiscard: () => ipcRenderer.invoke('confirm-discard'),
  notifySaved: () => ipcRenderer.send('saved'),
  notifySaveCancelled: () => ipcRenderer.send('save-cancelled'),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, cmd) => cb(cmd)),
  onOpenPath: (cb) => ipcRenderer.on('open-path', (_e, file) => cb(file)),
  onFileChanged: (cb) => ipcRenderer.on('file-changed', (_e, file) => cb(file)),
});
