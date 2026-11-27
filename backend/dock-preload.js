"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dock", {
  getSession: () => ipcRenderer.invoke("dock-pending"),
  action: (payload) => ipcRenderer.invoke("dock-action", payload || {}),
  onSession: (callback) => {
    const listener = (_event, session) => callback(session);
    ipcRenderer.on("dock-session", listener);
    return () => ipcRenderer.removeListener("dock-session", listener);
  },
});
