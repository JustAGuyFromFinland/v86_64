import { V86 } from "../../build/libv86.mjs";

const screenContainer = document.getElementById("screen");
const statusEl = document.getElementById("status");
const startBtn = document.getElementById("start");
const stopBtn = document.getElementById("stop");
const fullscreenBtn = document.getElementById("fullscreen");

const assetBase = new URL("../../", import.meta.url);
const remoteBase = "https://copy.sh/v86/";

const preferLocal = path => new URL(path, assetBase).href;

const biosCandidates = [
    preferLocal("bios/seabios.bin"),
    remoteBase + "bios/seabios.bin",
];
const vgaBiosCandidates = [
    preferLocal("bios/vgabios.bin"),
    remoteBase + "bios/vgabios.bin",
];
const floppyCandidates = [
    preferLocal("images/freedos722.img"),
    remoteBase + "images/freedos722.img",
];
const wasmCandidates = [
    preferLocal("build/v86.wasm"),
    preferLocal("build/v86-debug.wasm"),
    preferLocal("build/v86-fallback.wasm"),
    remoteBase + "build/v86.wasm",
    remoteBase + "build/v86-fallback.wasm",
];

let emulator = null;

const status = text => {
    statusEl.textContent = text;
};

async function fetchAsBuffer(name, candidates)
{
    let lastError;

    for(const url of candidates)
    {
        try
        {
            const res = await fetch(url);
            if(!res.ok)
            {
                lastError = new Error(`${name}: HTTP ${res.status} for ${url}`);
                continue;
            }
            const buf = new Uint8Array(await res.arrayBuffer());
            status(`${name} loaded from ${url}`);
            return { buffer: buf };
        }
        catch(err)
        {
            lastError = err;
        }
    }

    throw lastError || new Error(`Missing ${name}`);
}

async function loadWasm(env)
{
    let lastError;

    for(const url of wasmCandidates)
    {
        try
        {
            const res = await fetch(url);
            if(!res.ok)
            {
                lastError = new Error(`WASM: HTTP ${res.status} for ${url}`);
                continue;
            }

            const bytes = await res.arrayBuffer();
            const { instance } = await WebAssembly.instantiate(bytes, env);
            status(`WASM loaded from ${url}`);
            return instance.exports;
        }
        catch(err)
        {
            lastError = err;
        }
    }

    throw lastError || new Error("No wasm candidates succeeded");
}

function wireEvents(instance)
{
    instance.add_listener("download-progress", info => {
        const total = info.total || info.loaded || 1;
        const pct = Math.min(100, Math.round(info.loaded / total * 100));
        status(`Fetching ${info.file_name} (${pct}%)`);
    });

    instance.add_listener("download-error", info => {
        status(`Download failed: ${info.file_name}`);
    });

    instance.add_listener("emulator-ready", () => status("Ready"));
    instance.add_listener("emulator-loaded", () => status("Loaded"));
    instance.add_listener("emulator-started", () => status("Running"));
    instance.add_listener("emulator-stopped", () => status("Stopped"));
}

async function start()
{
    if(emulator)
    {
        status("Already running");
        return;
    }

    startBtn.disabled = true;
    stopBtn.disabled = false;

    try
    {
        status("Loading assets...");

        const [bios, vga_bios, fda] = await Promise.all([
            fetchAsBuffer("BIOS", biosCandidates),
            fetchAsBuffer("VGA BIOS", vgaBiosCandidates),
            fetchAsBuffer("FreeDOS", floppyCandidates),
        ]);

        emulator = new V86({
            wasm_fn: env => loadWasm(env),
            memory_size: 128 * 1024 * 1024,
            vga_memory_size: 8 * 1024 * 1024,
            screen_container: screenContainer,
            bios,
            vga_bios,
            fda,
            autostart: true,
            fastboot: true,
            disable_keyboard: false,
            disable_mouse: false,
        });

        wireEvents(emulator);
    }
    catch(err)
    {
        console.error(err);
        status(`Failed: ${err.message}`);
        stopBtn.disabled = true;
        startBtn.disabled = false;
        emulator = null;
    }
}

async function stop()
{
    if(!emulator)
    {
        return;
    }

    status("Stopping...");
    try
    {
        await emulator.stop();
        await emulator.destroy();
    }
    finally
    {
        emulator = null;
        stopBtn.disabled = true;
        startBtn.disabled = false;
        status("Stopped");
    }
}

startBtn.addEventListener("click", start);
stopBtn.addEventListener("click", stop);
fullscreenBtn.addEventListener("click", () => {
    window.electronAPI && window.electronAPI.toggleFullscreen();
});

screenContainer.addEventListener("click", () => {
    if(document.pointerLockElement !== screenContainer)
    {
        screenContainer.requestPointerLock();
    }
});

window.addEventListener("beforeunload", () => {
    if(emulator)
    {
        emulator.stop();
        emulator.destroy();
    }
});

start();
