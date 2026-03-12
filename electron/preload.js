const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
    toggleFullscreen: () => ipcRenderer.invoke("toggle-fullscreen"),
    platform: process.platform,
});

// Hint to v86 ScreenAdapter to run WebGPU rendering in a dedicated worker when available.
// Prefer worker-based WebGPU to keep the renderer main thread lighter in Electron.
contextBridge.exposeInMainWorld("USE_WEBGPU_WORKER", true);
