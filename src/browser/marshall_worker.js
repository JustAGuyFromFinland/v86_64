// Worker for marshalling/unmarshalling to keep the main thread responsive during large state moves.
import { Marshall, Unmarshall, compute_struct_size } from "../../lib/marshall.js";

self.onmessage = e => {
    const msg = e.data || {};
    const { id, type, typelist, offset = 0 } = msg;

    try {
        if(type === "marshall") {
            const size = compute_struct_size(typelist, msg.input) + offset;
            const struct = new Uint8Array(size);
            Marshall(typelist, msg.input, struct, offset);
            self.postMessage({ id, type: "done", payload: { buffer: struct.buffer } }, [struct.buffer]);
            return;
        }

        if(type === "unmarshall") {
            const struct = msg.struct instanceof Uint8Array ? msg.struct : new Uint8Array(msg.struct);
            const state = { offset };
            const output = Unmarshall(typelist, struct, state);
            self.postMessage({ id, type: "done", payload: { output, offset: state.offset } });
            return;
        }

        throw new Error("unknown message type: " + type);
    }
    catch(e) {
        self.postMessage({ id, type: "error", error: e && e.message ? e.message : String(e) });
    }
};
