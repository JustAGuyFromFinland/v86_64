// Dedicated timer worker to avoid main-thread throttling for emulator ticks.
let timeout = null;
let clock_source = "hpet";

self.onmessage = e => {
    const data = e.data || {};

    if(data.cmd === "init") {
        clock_source = data.clock_source || "hpet";
        return;
    }

    const delay = data.t < 1 ? 0 : data.t;

    if(timeout) {
        clearTimeout(timeout);
        timeout = null;
    }

    if(delay === 0) {
        self.postMessage(data.tick);
        return;
    }

    if(clock_source === "hpet" && typeof performance !== "undefined" && typeof performance.now === "function") {
        const target = performance.now() + delay;
        const schedule = () => {
            const remaining = target - performance.now();
            if(remaining <= 0) {
                self.postMessage(data.tick);
                timeout = null;
            }
            else {
                timeout = setTimeout(schedule, Math.min(remaining, 4));
            }
        };
        timeout = setTimeout(schedule, Math.min(delay, 4));
        return;
    }

    timeout = setTimeout(() => {
        self.postMessage(data.tick);
        timeout = null;
    }, delay);
};
