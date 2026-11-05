const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shelf", {
  onItems: (fn) => ipcRenderer.on("shelf-items", (_e, items) => fn(items)),
  drag: (files) => ipcRenderer.send("shelf-drag", files),
  add: (files) => ipcRenderer.send("shelf-add", files),
  remove: (file) => ipcRenderer.send("shelf-remove", file),
  open: (file) => ipcRenderer.send("shelf-open", file),
  clear: () => ipcRenderer.send("shelf-clear"),
  close: () => ipcRenderer.send("shelf-close"),
});
