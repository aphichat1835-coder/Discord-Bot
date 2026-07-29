"use strict";

const { readFiniteInteger } = require("./numbers");

const MAX_TIMEOUT_MS = 2_147_483_647;

function normalizeDelay(ms) {
    return readFiniteInteger(ms, { fallback: 0, min: 0, max: MAX_TIMEOUT_MS });
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

module.exports = {
    delay,
    withTimeoutValue,
    withTimeoutReject,
    _test: { normalizeDelay, MAX_TIMEOUT_MS }
};
