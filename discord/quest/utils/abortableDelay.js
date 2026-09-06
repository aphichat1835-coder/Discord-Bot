'use strict';

function abortFailure() {
    const error = new Error('aborted');
    error.name = 'AbortError';
    return error;
}

function abortableDelay(ms, signal, { unref = false } = {}) {
    if (signal?.aborted) return Promise.reject(abortFailure());

    return new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        const cleanup = () => signal?.removeEventListener('abort', onAbort);
        const onAbort = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            cleanup();
            reject(abortFailure());
        };

        timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
        }, Math.max(0, ms));
        if (unref && timer.unref) timer.unref();

        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
    });
}

module.exports = {
    abortableDelay,
    abortFailure
};
