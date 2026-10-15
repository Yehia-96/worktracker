const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  bootstrap: invoke('app:bootstrap'),
  getYear: invoke('year:get'),
  setEntry: invoke('entry:set'),
  clearEntry: invoke('entry:clear'),
  setRange: invoke('range:set'),
  saveSettings: invoke('settings:save'),
  exportCsv: invoke('export:csv'),
  exportPdf: invoke('export:pdf'),
  openDataFolder: invoke('data:openFolder'),
  openMain: invoke('main:open'),
  testPopup: invoke('popup:test'),

  popupGet: invoke('popup:get'),
  popupChoose: invoke('popup:choose'),
  popupSaveNote: invoke('popup:note'),
  popupSkipNote: invoke('popup:skipNote'),
  popupSnooze: invoke('popup:snooze'),
  popupClose: invoke('popup:close'),
  popupResize: invoke('popup:resize'),
  practiceNext: invoke('practice:next'),
  practiceCopy: invoke('practice:copy'),

  syncStatus: invoke('sync:status'),
  syncSignIn: invoke('sync:signIn'),
  syncSignUp: invoke('sync:signUp'),
  syncSignOut: invoke('sync:signOut'),
  syncNow: invoke('sync:now'),
  onSyncChanged: (cb) => ipcRenderer.on('sync:changed', () => cb()),

  onDataChanged: (cb) => ipcRenderer.on('data:changed', () => cb()),
  onNavigate: (cb) => ipcRenderer.on('navigate', (_e, view) => cb(view)),
});
