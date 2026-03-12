import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
    toggleFullscreen: () => ipcRenderer.invoke("toggle-fullscreen"),
    platform: process.platform,
});
