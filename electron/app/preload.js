const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nativeBridge", {
    platform: () => ipcRenderer.invoke("app:platform")
});
