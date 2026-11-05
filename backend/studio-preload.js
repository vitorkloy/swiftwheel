const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("studio", {
  job: () => ipcRenderer.invoke("studio-job"),
  finish: (spec) => ipcRenderer.send("studio-finish", spec),
  cancel: () => ipcRenderer.send("studio-cancel"),
  drag: (file) => ipcRenderer.send("studio-drag", file),
});
