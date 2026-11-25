const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("delshivHost", {
  quickbarRun: (text) => ipcRenderer.invoke("delshiv:quickbar-run", String(text || "")),
  quickbarHide: () => ipcRenderer.invoke("delshiv:quickbar-hide"),
  quickbarResize: (height) => ipcRenderer.invoke("delshiv:quickbar-resize", Number(height)),
});
