const { app, BrowserWindow, protocol, session, ipcMain } = require("electron");
const path = require("path");

const APP_SCHEME = "app";
const APP_ROOT = path.resolve(__dirname, "..", "..");
const WINDOW_OPTS = {
    width: 1280,
    height: 720,
    useContentSize: true,
    autoHideMenuBar: true,
    frame: false,
    fullscreen: true,
    backgroundColor: "#000000",
    show: false,
    webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webSecurity: true,
        scrollBounce: false,
        autoplayPolicy: "no-user-gesture-required",
        enableBlinkFeatures: "WebAssemblySimd,WebGPUDeveloperFeatures,SharedArrayBuffer"
    }
};

protocol.registerSchemesAsPrivileged([
    {
        scheme: APP_SCHEME,
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            corsEnabled: true,
            stream: true
        }
    }
]);

app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("enable-unsafe-webgpu");
app.commandLine.appendSwitch("enable-features", "SharedArrayBuffer,WebAssemblySimd,WebGPUDeveloperFeatures");

if (!app.requestSingleInstanceLock()) {
    app.quit();
}

function registerAppProtocol() {
    protocol.registerFileProtocol(APP_SCHEME, (request, callback) => {
        const url = new URL(request.url);
        const decodedPath = decodeURIComponent(url.pathname);
        let relativePath = decodedPath.slice(1);

        // Normalize trailing slash to index.html for convenience (app:// or app://folder/)
        if (relativePath === "" || relativePath.endsWith("/")) {
            relativePath = path.join(relativePath, "index.html");
        }

        const resolvedPath = path.resolve(APP_ROOT, relativePath);
        if (!resolvedPath.startsWith(APP_ROOT)) {
            return callback({ error: -10 });
        }
        callback({ path: resolvedPath });
    });
}

function enforceCrossOriginIsolation() {
    const filter = { urls: ["app://*/*"] };
    session.defaultSession.webRequest.onHeadersReceived(filter, (details, callback) => {
        const headers = {
            ...details.responseHeaders,
            "Cross-Origin-Opener-Policy": ["same-origin"],
            "Cross-Origin-Embedder-Policy": ["require-corp"]
        };
        callback({ responseHeaders: headers });
    });
}

function createWindow() {
    const win = new BrowserWindow(WINDOW_OPTS);

    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.once("ready-to-show", () => {
        win.show();
        win.focus();
    });

    const entry = `${APP_SCHEME}://index.html`;
    win.loadURL(entry).catch(err => {
        console.error("Failed to load entry", err);
    });

    return win;
}

function setupIpc() {
    ipcMain.handle("app:platform", () => process.platform);
}

app.whenReady().then(() => {
    registerAppProtocol();
    enforceCrossOriginIsolation();
    setupIpc();
    createWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});

app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
        if (!win.isVisible()) win.show();
        win.focus();
    }
});
