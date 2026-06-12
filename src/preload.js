/**
 * preload.js — Puente seguro entre main y renderer
 * =================================================
 * Expone las funciones IPC a la UI a través de `window.launcher.*`.
 * contextIsolation: true para que el renderer no tenga acceso directo a Node.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  // Configuración
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (partial) => ipcRenderer.invoke('config:set', partial),

  // Autenticación
  login: (username) => ipcRenderer.invoke('auth:login', username),
  logout: () => ipcRenderer.invoke('auth:logout'),

  // Emulador
  launchEmulator: () => ipcRenderer.invoke('emulator:launch'),
  stopEmulator: () => ipcRenderer.invoke('emulator:stop'),
  emulatorStatus: () => ipcRenderer.invoke('emulator:status'),

  // Sav
  uploadNow: () => ipcRenderer.invoke('sav:upload-now'),

  // Webapp
  openWebapp: () => ipcRenderer.invoke('webapp:open'),

  // Sistema
  checkSystem: () => ipcRenderer.invoke('system:check'),
  systemInfo: () => ipcRenderer.invoke('system:info'),
  openLog: () => ipcRenderer.invoke('system:open-log'),
  resetApp: () => ipcRenderer.invoke('app:reset'),

  // Auto-update
  checkUpdate:     () => ipcRenderer.invoke('update:check'),
  installUpdate:   () => ipcRenderer.invoke('update:install'),
  getVersion:      () => ipcRenderer.invoke('update:get-version'),

  // Eventos del backend (suscripciones)
  onUploadStart:    (cb) => ipcRenderer.on('upload:start',    (_, d) => cb(d)),
  onUploadSuccess:  (cb) => ipcRenderer.on('upload:success',  (_, d) => cb(d)),
  onUploadError:    (cb) => ipcRenderer.on('upload:error',    (_, d) => cb(d)),
  onEmulatorStopped:(cb) => ipcRenderer.on('emulator:stopped',(_, d) => cb(d)),
  onTrackerReminder:(cb) => ipcRenderer.on('tracker:reminder',(_, d) => cb(d)),
  onUpdateStatus:   (cb) => ipcRenderer.on('update:status',   (_, d) => cb(d)),
});
