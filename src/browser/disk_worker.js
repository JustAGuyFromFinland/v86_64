// Disk fetch worker: offloads HTTP range/file downloads from main thread.

self.onmessage = async ev => {
    const msg = ev.data;
    if(!msg || msg.type !== "load") return;

    const { id, url, as_json, range, headers } = msg;

    try {
        const fetchHeaders = new Headers(headers || {});
        if(range && range.start !== undefined && range.length !== undefined)
        {
            const start = range.start;
            const end = start + range.length - 1;
            fetchHeaders.set("Range", `bytes=${start}-${end}`);
            fetchHeaders.set("X-Accept-Encoding", "identity");
        }

        const resp = await fetch(url, { method: "GET", headers: fetchHeaders });
        if(!resp.ok && resp.status !== 206)
        {
            self.postMessage({ type: "error", id, status: resp.status, message: `HTTP ${resp.status}` });
            return;
        }

        const contentLength = resp.headers.get("Content-Length");
        let total = contentLength ? Number(contentLength) : undefined;
        if(resp.status === 206)
        {
            const cr = resp.headers.get("Content-Range");
            const m = cr && cr.match(/\/(\d+)/);
            if(m) total = Number(m[1]);
        }

        if(as_json)
        {
            const text = await resp.text();
            const json = JSON.parse(text);
            self.postMessage({ type: "done", id, json });
            return;
        }

        let buffer;
        if(resp.body && resp.body.getReader)
        {
            const reader = resp.body.getReader();
            let loaded = 0;
            const chunks = [];
            while(true)
            {
                const { done, value } = await reader.read();
                if(done) break;
                chunks.push(value);
                loaded += value.byteLength;
                self.postMessage({ type: "progress", id, loaded, total });
            }
            const out = new Uint8Array(loaded);
            let offset = 0;
            for(const chunk of chunks)
            {
                out.set(chunk, offset);
                offset += chunk.byteLength;
            }
            buffer = out.buffer;
        }
        else
        {
            buffer = await resp.arrayBuffer();
            total = buffer.byteLength;
        }

        self.postMessage({ type: "done", id, buffer, total }, buffer ? [buffer] : undefined);
    }
    catch(e)
    {
        self.postMessage({ type: "error", id, message: e?.message || String(e) });
    }
};
