"use strict";

function normalizeDelay(ms) {
    return Math.max(0, Number(ms) || 0);
}

function delay(ms, value = undefined) {
    return new Promise(resolve => {
        setTimeout(() => resolve(value), normalizeDelay(ms));
    });
}

async function withTimeoutValue(promise, timeoutMs, timeoutValue) {
    let timer = null;
    try {
        return await Promise.race([
  Promise.resolve(promise).finally(() => {
      if (timer) clearTimeout(timer);
  }),
  new Promise(resolve => {
      timer = setTimeout(() => resolve(timeoutValue), normalizeDelay(timeoutMs));
  })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function withTimeoutReject(promise, timeoutMs, message) {
    let timer = null;
    try {
        return await Promise.race([
  Promise.resolve(promise).finally(() => {
      if (timer) clearTimeout(timer);
  }),
  new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), normalizeDelay(timeoutMs));
  })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

module.exports = { delay, withTimeoutValue, withTimeoutReject };
