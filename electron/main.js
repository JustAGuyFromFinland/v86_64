const { app, BrowserWindow, ipcMain, protocol, session } = require("electron");
const { join, resolve } = require("node:path");

const APP_SCHEME = "app";
const APP_ROOT = resolve(__dirname, "..");

const jsFlags = [
  '--experimental-wasm-threads',
  '--experimental-wasm-simd',
  '--experimental-wasm-gc',
  '--wasm-max-mem-pages=65536',
  '--liftoff',
  '--wasm-tier-up',
  '--harmony-sharedarraybuffer',
  '--max-semi-space-size=128',
  '--max-old-space-size=4096',
  '--concurrent-recompilation',
  '--wasm-num-compilation-tasks=8',
  '--no-wasm-lazy-compilation'
].join(' ');

app.commandLine.appendSwitch('js-flags', jsFlags);

// 2. GPU & System Features
const featuresToEnable = [
  'SharedArrayBuffer',
  'WebAssemblySimd',
  'WebAssemblyThreads',
  'WebGPUDeveloperFeatures',
  'CanvasOopRasterization',
  'WebGPU'
].join(',');

const featuresToDisable = [
  'CalculateNativeWinOcclusion',
  'BackgroundTracing',
  'ResourceLoadScheduler'
].join(',');

// 3. Apply all switches
app.commandLine.appendSwitch('enable-features', featuresToEnable);
app.commandLine.appendSwitch('disable-features', featuresToDisable);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-native-gpu-memory-buffers');
app.commandLine.appendSwitch('enable-highres-timer');
app.commandLine.appendSwitch('enable-gpu-rasterization');

// Ensure COOP/COEP for SharedArrayBuffer and worker WebGPU
function enforceCrossOriginIsolation()
{
    const filter = { urls: ["app://*/*"] };
    session.defaultSession.webRequest.onHeadersReceived(filter, (details, callback) => {
        const headers = {
            ...details.responseHeaders,
            "Cross-Origin-Opener-Policy": ["same-origin"],
            "Cross-Origin-Embedder-Policy": ["require-corp"],
        };
        callback({ responseHeaders: headers });
    });
}

function registerAppProtocol()
{
    protocol.registerFileProtocol(APP_SCHEME, (request, callback) => {
        const url = new URL(request.url);
        const decodedPath = decodeURIComponent(url.pathname);
        let relativePath = decodedPath.slice(1);

        if(relativePath === "" || relativePath.endsWith("/"))
        {
            relativePath = join(relativePath, "index.html");
        }

        const resolvedPath = resolve(APP_ROOT, relativePath);
        if(!resolvedPath.startsWith(APP_ROOT))
        {
            return callback({ error: -10 });
        }
        callback({ path: resolvedPath });
    });
}

const createWindow = () => {
    const win = new BrowserWindow({
        title: "v86",
        width: 1280,
        height: 800,
        backgroundColor: "#000000",
        autoHideMenuBar: true,
        fullscreen: true,
        // NEW: Prevents the window from being "occluded" or slowed down by the OS 
        // when other windows are on top of it.
        paintWhenInitiallyHidden: true, 
        
        webPreferences: {
            preload: join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            
            // --- PERFORMANCE TWEAKS ---
            backgroundThrottling: false, // Prevents v86 from pausing when minimized
            offscreen: false,            // Ensure hardware acceleration is direct
            
            // UPDATED: Move these to "enableBlinkFeatures"
            // Note: SharedArrayBuffer usually requires COOP/COEP headers, 
            // but in Electron, this flag helps bypass those requirements locally.
            enableBlinkFeatures: "WebAssemblySimd,WebAssemblyThreads,SharedArrayBuffer",

            // NEW: Allow Wasm to use more than the default memory limit 
            // (v86 often needs large contiguous buffers for RAM emulation)
            wasmManagedMemory: true, 
            spellcheck: false,
            v8CacheOptions: 'bypassHeatCheck',

            // NEW: If you are using WebGPU for video scaling/output in v86
            webgl: true,
        },
    });

    // Toggle DevTools with F12 for debugging (especially WebGPU issues).
    win.webContents.on("before-input-event", (event, input) => {
        if(input.key === "F12" && !input.control && !input.alt && !input.meta && !input.shift)
        {
            event.preventDefault();
            if(win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
            else win.webContents.openDevTools({ mode: "detach" });
        }
    });

    // Load the main project page via app:// to get COOP/COEP headers.
    win.loadURL(`${APP_SCHEME}://index.html`);
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

// Must be called before app ready
protocol.registerSchemesAsPrivileged([
    {
        scheme: APP_SCHEME,
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            corsEnabled: true,
            stream: true,
        },
    },
]);

app.whenReady().then(() => {
    registerAppProtocol();
    enforceCrossOriginIsolation();
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
