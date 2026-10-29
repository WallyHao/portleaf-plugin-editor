import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI } from '@portleaf/core';

ipcRenderer.on('repo-port', (event) =>
  window.postMessage({ type: 'portleaf-repo' }, '*', event.ports),
);
const api: DesktopAPI = {
  bootstrap: () => ipcRenderer.invoke('bootstrap'),
  connect: () => ipcRenderer.send('connect'),
  list: (directory, options) => ipcRenderer.invoke('list', directory, options),
  browse: (directory, options) => ipcRenderer.invoke('browse', directory, options),
  preview: (file) => ipcRenderer.invoke('preview', file),
  inspect: (file) => ipcRenderer.invoke('inspect', file),
  watchResource: (file, enabled) => ipcRenderer.invoke('watch-resource', file, enabled),
  mkdir: (directory) => ipcRenderer.invoke('mkdir', directory),
  copy: (file, target) => ipcRenderer.invoke('copy', file, target),
  open: (file) => ipcRenderer.invoke('open', file),
  create: (file, retain) => ipcRenderer.invoke('create', file, retain),
  release: (file, heads, url) => ipcRenderer.invoke('release', file, heads, url),
  diagnostics: () => ipcRenderer.invoke('diagnostics'),
  saveRecovery: (documents) => ipcRenderer.invoke('save-recovery', documents),
  restart: (documents) => ipcRenderer.invoke('restart', documents),
  rename: (file, target) => ipcRenderer.invoke('rename', file, target),
  openLink: (file, target) => ipcRenderer.invoke('open-link', file, target),
  flush: (documents) => ipcRenderer.invoke('flush', documents),
  history: (file) => ipcRenderer.invoke('history', file),
  restore: (file, heads) => ipcRenderer.invoke('restore', file, heads),
  setTheme: (theme) => ipcRenderer.invoke('theme', theme),
  quit: (documents) => ipcRenderer.invoke('quit', documents),
  onEvent: (callback) => {
    const listener = (_event: unknown, data: Parameters<typeof callback>[0]) => callback(data);
    ipcRenderer.on('event', listener);
    return () => ipcRenderer.off('event', listener);
  },
};
contextBridge.exposeInMainWorld('portleaf', api);
