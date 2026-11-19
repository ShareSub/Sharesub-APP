const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('shareSub', Object.freeze({
  call: (method, payload) => ipcRenderer.invoke('sharesub:request', method, payload)
}));
