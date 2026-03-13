const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
    toggleFullscreen: () => ipcRenderer.invoke("toggle-fullscreen"),
    platform: process.platform,
});

// Hint to v86 ScreenAdapter to run WebGPU rendering in a dedicated worker when available.
// Prefer worker-based WebGPU to keep the renderer main thread lighter in Electron.
contextBridge.exposeInMainWorld("USE_WEBGPU_WORKER", true);
// Allow CPU tick scheduling to run on a dedicated worker as well.
contextBridge.exposeInMainWorld("USE_TICK_WORKER", true);
// Offload struct marshalling/unmarshalling when large state blobs are processed.
contextBridge.exposeInMainWorld("USE_MARSHALL_WORKER", true);
contextBridge.exposeInMainWorld("USE_DISK_WORKER", true);
