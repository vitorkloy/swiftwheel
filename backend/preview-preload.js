"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("preview", {
  getSession: () => ipcRenderer.invoke("preview-pending"),
  action: (action) => ipcRenderer.invoke("preview-action", { action }),
  onSession: (callback) => {
    const listener = (_event, session) => callback(session);
    ipcRenderer.on("preview-session", listener);
    return () => ipcRenderer.removeListener("preview-session", listener);
  },
  onAppearance: (callback) => {
    const listener = (_event, appearance) => callback(appearance);
    ipcRenderer.on("preview-appearance", listener);
    return () => ipcRenderer.removeListener("preview-appearance", listener);
  },
});
