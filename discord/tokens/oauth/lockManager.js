"use strict";

const { refreshLocks } = require("./state");

function raceWithSignal(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
        let onAbort;
        onAbort = () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        Promise.resolve(promise).then(
            val => {
                signal.removeEventListener("abort", onAbort);
                resolve(val);
            },
            err => {
                signal.removeEventListener("abort", onAbort);
                reject(err);
            }
        );
    });
}

async function withTokenRefreshLock(key, fn, signal = null) {
    if (signal?.aborted) {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
    }

    const previous = refreshLocks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const current = previous.catch(() => {}).then(() => gate);
    refreshLocks.set(key, current);

    try {
        if (signal) {
            let abortListener;
            const abortPromise = new Promise((_, reject) => {
                abortListener = () => {
                    const err = new Error("The operation was aborted");
                    err.name = "AbortError";
                    reject(err);
                };
                signal.addEventListener("abort", abortListener, { once: true });
            });
            try {
                await Promise.race([previous.catch(() => {}), abortPromise]);
            } finally {
                if (abortListener) signal.removeEventListener("abort", abortListener);
            }
        } else {
            await previous.catch(() => {});
        }

        if (signal?.aborted) {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            throw err;
        }

        return await fn();
    } finally {
        release();
        if (refreshLocks.get(key) === current) refreshLocks.delete(key);
    }
}

module.exports = {
    raceWithSignal,
    withTokenRefreshLock,
    withOAuthTokenStateLock: withTokenRefreshLock
};
