"use strict";

function isBlankNumericInput(value) {
    return typeof value === "string" && value.trim() === "";
}

function readFiniteNumber(value, options = {}) {
    const fallback = Number(options.fallback ?? 0);
    const minimum = Number.isFinite(Number(options.min)) ? Number(options.min) : -Number.MAX_SAFE_INTEGER;
    const maximum = Number.isFinite(Number(options.max)) ? Number(options.max) : Number.MAX_SAFE_INTEGER;
    const integer = options.integer === true;

    let resolved = value === null || value === undefined || isBlankNumericInput(value)
        ? Number.NaN
        : Number(value);
    if (!Number.isFinite(resolved)) resolved = Number.isFinite(fallback) ? fallback : 0;
    if (integer) resolved = Math.trunc(resolved);
    return Math.min(maximum, Math.max(minimum, resolved));
}

function readFiniteInteger(value, options = {}) {
    return readFiniteNumber(value, { ...options, integer: true });
}

module.exports = {
    isBlankNumericInput,
    readFiniteInteger,
    readFiniteNumber
};