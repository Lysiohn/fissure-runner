const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  setScanArea: (area) => ipcRenderer.send('set-scan-area', area)
});
