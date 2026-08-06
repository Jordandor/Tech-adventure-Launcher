'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function on(channel, listener) {
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('launcher', {
  getState: () => ipcRenderer.invoke('launcher:get-state'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  selectPack: (packId) => ipcRenderer.invoke('packs:select', packId),
  openMods: () => ipcRenderer.invoke('mods:open'),
  listMods: () => ipcRenderer.invoke('mods:list'),
  analyzeModToggle: (fileName, enabled) => ipcRenderer.invoke('mods:analyze-toggle', { fileName, enabled }),
  toggleMod: (fileName, enabled, cascade = false) => ipcRenderer.invoke('mods:toggle', { fileName, enabled, cascade }),
  setAllMods: (enabled) => ipcRenderer.invoke('mods:set-all', { enabled }),
  openModsFolder: () => ipcRenderer.invoke('mods:open-folder'),
  chooseGameDirectory: () => ipcRenderer.invoke('dialog:choose-game-directory'),
  chooseJava: () => ipcRenderer.invoke('dialog:choose-java'),
  microsoftLogin: () => ipcRenderer.invoke('auth:microsoft-login'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  verify: () => ipcRenderer.invoke('launcher:verify'),
  play: () => ipcRenderer.invoke('launcher:play'),
  refreshPackInfo: () => ipcRenderer.invoke('launcher:refresh-pack-info'),
  refreshServerStatus: () => ipcRenderer.invoke('launcher:refresh-server-status'),
  openGameDirectory: () => ipcRenderer.invoke('launcher:open-game-directory'),
  openLogs: () => ipcRenderer.invoke('launcher:open-logs'),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  close: () => ipcRenderer.invoke('window:close'),
  onProgress: (listener) => on('launcher:progress', listener),
  onBusy: (listener) => on('launcher:busy', listener),
  onWarning: (listener) => on('launcher:warning', listener),
  onPackInfo: (listener) => on('launcher:pack-info', listener),
  onServerStatus: (listener) => on('server:status', listener),
  onModsChanged: (listener) => on('mods:changed', listener),
  onModsLock: (listener) => on('mods:lock', listener),
  onLog: (listener) => on('launcher:log', listener),
  onDeviceCode: (listener) => on('auth:device-code', listener),
  onAuthState: (listener) => on('auth:state', listener),
  onGameState: (listener) => on('game:state', listener),
  onUpdateState: (listener) => on('update:state', listener)
});

contextBridge.exposeInMainWorld('techAdventureSkins', {
  status: (name) => ipcRenderer.invoke('skins:status', { name }),
  getSkin: (name, kind) => ipcRenderer.invoke('skins:get', { name, kind }),
  upload: (name, bytes) => ipcRenderer.invoke('skins:upload', { name, bytes }),
  players: () => ipcRenderer.invoke('skins:players')
});
