import { app, BrowserWindow, ipcMain } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

const createWindow = () => {
    const win = new BrowserWindow({
        title: "v86",
        width: 1280,
        height: 800,
        backgroundColor: "#000000",
        autoHideMenuBar: true,
        fullscreen: true,
        webPreferences: {
            preload: join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false,
        },
    });

    win.loadFile(join(__dirname, "renderer", "index.html"));
};

ipcMain.handle("toggle-fullscreen", event => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if(!win) {
        return false;
    }
    const target = !win.isFullScreen();
    win.setFullScreen(target);
    return target;
});

app.whenReady().then(() => {
    createWindow();

    app.on("activate", () => {
        if(BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on("window-all-closed", () => {
    if(process.platform !== "darwin") {
        app.quit();
    }
});
