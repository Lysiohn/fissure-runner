const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('osdAPI', {
  onUpdateData: (callback) => ipcRenderer.on('update-osd-data', callback),
  onUpdateStyle: (callback) => ipcRenderer.on('update-osd-style', callback),
});
