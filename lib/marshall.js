// -------------------------------------------------
// ------------------ Marshall ---------------------
// -------------------------------------------------
// helper functions for virtio and 9p.

import { dbg_log } from "./../src/log.js";

const textde = new TextDecoder();
const texten = new TextEncoder();

// Optional worker-backed marshalling to offload large struct packing/unpacking.
const marshall_worker_supported = typeof Worker !== "undefined";
let marshall_worker = null;
let marshall_request_id = 0;
const marshall_requests = new Map();

function maybe_init_marshall_worker()
{
    if(marshall_worker || !marshall_worker_supported || !globalThis.USE_MARSHALL_WORKER)
    {
        return marshall_worker;
    }

    try
    {
        const base = (typeof document !== "undefined" && document.baseURI) ? document.baseURI : (typeof location !== "undefined" ? location.href : undefined);
        const worker_relative = "src/browser/marshall_worker.js";
        const worker_url = base ? new URL(worker_relative, base).toString() : worker_relative;
        marshall_worker = new Worker(worker_url, { type: "module" });

        marshall_worker.onmessage = ev =>
        {
            const msg = ev.data;
            const pending = msg && marshall_requests.get(msg.id);
            if(!pending) return;

            marshall_requests.delete(msg.id);
            if(msg.type === "done")
            {
                pending.resolve(msg.payload);
            }
            else
            {
                pending.reject(new Error(msg.error || "marshall worker error"));
            }
        };

        marshall_worker.onerror = e =>
        {
            marshall_requests.forEach(p => p.reject(e));
            marshall_requests.clear();
            marshall_worker = null;
        };
    }
    catch(e)
    {
        marshall_worker = null;
    }

    return marshall_worker;
}

export function compute_struct_size(typelist, input)
{
    let size = 0;
    for(let i = 0; i < typelist.length; i++)
    {
        const type = typelist[i];
        switch(type)
        {
            case "w": size += 4; break;
            case "d": size += 8; break;
            case "h": size += 2; break;
            case "b": size += 1; break;
            case "s": size += 2 + texten.encode(input[i]).byteLength; break;
            case "Q": size += 13; break;
            default: break;
        }
    }
    return size;
}

// Inserts data from an array to a byte aligned struct in memory
export function Marshall(typelist, input, struct, offset) {
    var item;
    var size = 0;
    for(var i=0; i < typelist.length; i++) {
        item = input[i];
        switch(typelist[i]) {
            case "w":
                struct[offset++] = item & 0xFF;
                struct[offset++] = (item >> 8) & 0xFF;
                struct[offset++] = (item >> 16) & 0xFF;
                struct[offset++] = (item >> 24) & 0xFF;
                size += 4;
                break;
            case "d": // double word
                struct[offset++] = item & 0xFF;
                struct[offset++] = (item >> 8) & 0xFF;
                struct[offset++] = (item >> 16) & 0xFF;
                struct[offset++] = (item >> 24) & 0xFF;
                struct[offset++] = 0x0;
                struct[offset++] = 0x0;
                struct[offset++] = 0x0;
                struct[offset++] = 0x0;
                size += 8;
                break;
            case "h":
                struct[offset++] = item & 0xFF;
                struct[offset++] = item >> 8;
                size += 2;
                break;
            case "b":
                struct[offset++] = item;
                size += 1;
                break;
            case "s":
                var lengthoffset = offset;
                var length = 0;
                struct[offset++] = 0; // set the length later
                struct[offset++] = 0;
                size += 2;

                var stringBytes = texten.encode(item);
                size += stringBytes.byteLength;
                length += stringBytes.byteLength;
                struct.set(stringBytes, offset);
                offset += stringBytes.byteLength;

                struct[lengthoffset+0] = length & 0xFF;
                struct[lengthoffset+1] = (length >> 8) & 0xFF;
                break;
            case "Q":
                Marshall(["b", "w", "d"], [item.type, item.version, item.path], struct, offset);
                offset += 13;
                size += 13;
                break;
            default:
                dbg_log("Marshall: Unknown type=" + typelist[i]);
                break;
        }
    }
    return size;
}


// Extracts data from a byte aligned struct in memory to an array
export function Unmarshall(typelist, struct, state) {
    let offset = state.offset;
    var output = [];
    for(var i=0; i < typelist.length; i++) {
        switch(typelist[i]) {
            case "w":
                var val = struct[offset++];
                val += struct[offset++] << 8;
                val += struct[offset++] << 16;
                val += (struct[offset++] << 24) >>> 0;
                output.push(val);
                break;
            case "d":
                var val = struct[offset++];
                val += struct[offset++] << 8;
                val += struct[offset++] << 16;
                val += (struct[offset++] << 24) >>> 0;
                offset += 4;
                output.push(val);
                break;
            case "h":
                var val = struct[offset++];
                output.push(val + (struct[offset++] << 8));
                break;
            case "b":
                output.push(struct[offset++]);
                break;
            case "s":
                var len = struct[offset++];
                len += struct[offset++] << 8;

                var stringBytes = struct.slice(offset, offset + len);
                offset += len;
                output.push(textde.decode(stringBytes));
                break;
            case "Q":
                state.offset = offset;
                const qid = Unmarshall(["b", "w", "d"], struct, state);
                offset = state.offset;
                output.push({
                    type: qid[0],
                    version: qid[1],
                    path: qid[2],
                });
                break;
            default:
                dbg_log("Error in Unmarshall: Unknown type=" + typelist[i]);
                break;
        }
    }
    state.offset = offset;
    return output;
}

function send_marshall_request(message, transfer)
{
    const worker = maybe_init_marshall_worker();
    if(!worker)
    {
        return null;
    }

    return new Promise((resolve, reject) => {
        const id = ++marshall_request_id;
        marshall_requests.set(id, { resolve, reject });
        worker.postMessage({ ...message, id }, transfer || []);
    });
}

/**
 * Offload marshalling to a worker when available.
 * @return {!Promise<Uint8Array>}
 */
export async function MarshallOffthread(typelist, input, options)
{
    const offset = options?.offset | 0;

    const transfer = [];
    const request = send_marshall_request({
        type: "marshall",
        typelist,
        input,
        offset,
    }, transfer);

    if(request)
    {
        try
        {
            const payload = await request;
            return new Uint8Array(payload.buffer);
        }
        catch(e)
        {
            // fall back to synchronous path on worker errors
        }
    }

    const size = compute_struct_size(typelist, input) + offset;
    const struct = new Uint8Array(size);
    Marshall(typelist, input, struct, offset);
    return struct;
}

/**
 * Offload unmarshalling to a worker when available.
 * @return {!Promise<{ output: Array, offset: number }>}
 */
export async function UnmarshallOffthread(typelist, struct, options)
{
    const offset = options?.offset | 0;
    const transfer = options?.transfer ? [struct.buffer] : undefined;
    const request = send_marshall_request({
        type: "unmarshall",
        typelist,
        struct,
        offset,
    }, transfer);

    if(request)
    {
        try
        {
            const payload = await request;
            return { output: payload.output, offset: payload.offset };
        }
        catch(e)
        {
            // fall back to synchronous path on worker errors
        }
    }

    const state = { offset };
    const output = Unmarshall(typelist, struct, state);
    return { output, offset: state.offset };
}
