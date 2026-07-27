"use strict";

function isBlankValue(value) {
    return value === undefined || value === null ||
        (typeof value === "string" && value.trim() === "");
}

function finiteOption(value, fallback) {
    if (isBlankValue(value)) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function readFiniteNumber(value, options = {}) {
    const fallback = finiteOption(options.fallback, 0);
    const minimum = finiteOption(options.min, -Number.MAX_SAFE_INTEGER);
    const maximum = finiteOption(options.max, Number.MAX_SAFE_INTEGER);
    const integer = options.integer === true;

    let resolved = isBlankValue(value) ? fallback : Number(value);
    if (!Number.isFinite(resolved)) resolved = fallback;
    if (integer) resolved = Math.trunc(resolved);
    return Math.min(maximum, Math.max(minimum, resolved));
}

function readFiniteInteger(value, options = {}) {
    return readFiniteNumber(value, { ...options, integer: true });
}

module.exports = {
    readFiniteInteger,
    readFiniteNumber,
    _test: {
        isBlankValue,
        finiteOption
    }
};