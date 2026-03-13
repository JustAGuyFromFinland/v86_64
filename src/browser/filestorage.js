import { dbg_assert } from "../log.js";
import { load_file } from "../lib.js";

// Optional disk-fetch worker to offload image reads from the main thread.
const disk_worker_supported = typeof Worker !== "undefined";
let disk_worker = null;
let disk_request_id = 0;
const disk_requests = new Map();

if(globalThis.USE_DISK_WORKER && disk_worker_supported)
{
    try
    {
        const base = (typeof document !== "undefined" && document.baseURI) ? document.baseURI : (typeof location !== "undefined" ? location.href : undefined);
        const worker_relative = "src/browser/disk_worker.js";
        const worker_url = base ? new URL(worker_relative, base).toString() : worker_relative;
        disk_worker = new Worker(worker_url, { type: "module" });

        disk_worker.onmessage = ev =>
        {
            const msg = ev.data;
            const pending = msg && disk_requests.get(msg.id);
            if(!pending) return;

            switch(msg.type)
            {
                case "progress":
                    if(pending.progress)
                    {
                        pending.progress({ loaded: msg.loaded, total: msg.total });
                    }
                    break;
                case "done":
                    disk_requests.delete(msg.id);
                    if(msg.error)
                    {
                        pending.reject(new Error(msg.error));
                    }
                    else if(pending.as_json)
                    {
                        pending.resolve(msg.json);
                    }
                    else
                    {
                        pending.resolve(msg.buffer);
                    }
                    break;
                case "error":
                    disk_requests.delete(msg.id);
                    pending.reject(new Error(msg.message || "disk worker error"));
                    break;
                default:
                    break;
            }
        };

        disk_worker.onerror = e =>
        {
            disk_requests.forEach(p => p.reject(e));
            disk_requests.clear();
            disk_worker = null;
        };
    }
    catch(e)
    {
        disk_worker = null;
    }
}

async function load_file_via_disk_worker(filename, options)
{
    if(!disk_worker)
    {
        return await new Promise((resolve, reject) => {
            load_file(filename, {
                ...options,
                done: resolve,
                progress: options?.progress,
            });
        });
    }

    return await new Promise((resolve, reject) => {
        const id = ++disk_request_id;
        disk_requests.set(id, {
            resolve,
            reject,
            progress: options?.progress,
            as_json: !!options?.as_json,
        });

        disk_worker.postMessage({
            type: "load",
            id,
            url: filename,
            as_json: !!options?.as_json,
            range: options?.range || null,
            headers: options?.headers || null,
        });
    });
}

export { load_file_via_disk_worker as load_file_offthread };

/** @interface */
export function FileStorageInterface() {}

/**
 * Read a portion of a file.
 * @param {string} sha256sum
 * @param {number} offset
 * @param {number} count
 * @param {number} file_size
 * @return {!Promise<Uint8Array>} null if file does not exist.
 */
FileStorageInterface.prototype.read = function(sha256sum, offset, count, file_size) {};

/**
 * Add a read-only file to the filestorage.
 * @param {string} sha256sum
 * @param {!Uint8Array} data
 * @return {!Promise}
 */
FileStorageInterface.prototype.cache = function(sha256sum, data) {};

/**
 * Call this when the file won't be used soon, e.g. when a file closes or when this immutable
 * version is already out of date. It is used to help prevent accumulation of unused files in
 * memory in the long run for some FileStorage mediums.
 */
FileStorageInterface.prototype.uncache = function(sha256sum) {};

/**
 * @constructor
 * @implements {FileStorageInterface}
 */
export function MemoryFileStorage()
{
    /**
     * From sha256sum to file data.
     * @type {Map<string,Uint8Array>}
     */
    this.filedata = new Map();
}

/**
 * @param {string} sha256sum
 * @param {number} offset
 * @param {number} count
 * @return {!Promise<Uint8Array>} null if file does not exist.
 */
MemoryFileStorage.prototype.read = async function(sha256sum, offset, count)
{
    dbg_assert(sha256sum, "MemoryFileStorage read: sha256sum should be a non-empty string");
    const data = this.filedata.get(sha256sum);

    if(!data)
    {
        return null;
    }

    return data.subarray(offset, offset + count);
};

/**
 * @param {string} sha256sum
 * @param {!Uint8Array} data
 */
MemoryFileStorage.prototype.cache = async function(sha256sum, data)
{
    dbg_assert(sha256sum, "MemoryFileStorage cache: sha256sum should be a non-empty string");
    this.filedata.set(sha256sum, data);
};

/**
 * @param {string} sha256sum
 */
MemoryFileStorage.prototype.uncache = function(sha256sum)
{
    this.filedata.delete(sha256sum);
};

/**
 * @constructor
 * @implements {FileStorageInterface}
 * @param {FileStorageInterface} file_storage
 * @param {string} baseurl
 * @param {function(number,Uint8Array):ArrayBuffer} zstd_decompress
 */
export function ServerFileStorageWrapper(file_storage, baseurl, zstd_decompress)
{
    dbg_assert(baseurl, "ServerMemoryFileStorage: baseurl should not be empty");

    if(!baseurl.endsWith("/"))
    {
        baseurl += "/";
    }

    this.storage = file_storage;
    this.baseurl = baseurl;
    this.zstd_decompress = zstd_decompress;
}

/**
 * @param {string} sha256sum
 * @param {number} file_size
 * @return {!Promise<Uint8Array>}
 */
ServerFileStorageWrapper.prototype.load_from_server = async function(sha256sum, file_size)
{
    const buffer = await load_file_via_disk_worker(this.baseurl + sha256sum, { as_json: false });
    let data = new Uint8Array(buffer);
    if(sha256sum.endsWith(".zst"))
    {
        data = new Uint8Array(
            this.zstd_decompress(file_size, data)
        );
    }
    await this.cache(sha256sum, data);
    return data;
};

/**
 * @param {string} sha256sum
 * @param {number} offset
 * @param {number} count
 * @param {number} file_size
 * @return {!Promise<Uint8Array>}
 */
ServerFileStorageWrapper.prototype.read = async function(sha256sum, offset, count, file_size)
{
    const data = await this.storage.read(sha256sum, offset, count, file_size);
    if(!data)
    {
        const full_file = await this.load_from_server(sha256sum, file_size);
        return full_file.subarray(offset, offset + count);
    }
    return data;
};

/**
 * @param {string} sha256sum
 * @param {!Uint8Array} data
 */
ServerFileStorageWrapper.prototype.cache = async function(sha256sum, data)
{
    return await this.storage.cache(sha256sum, data);
};

/**
 * @param {string} sha256sum
 */
ServerFileStorageWrapper.prototype.uncache = function(sha256sum)
{
    this.storage.uncache(sha256sum);
};
