"use strict";

const crypto = require("node:crypto");

const PREFIX = "scrypt-v1";
const KEY_LENGTH = 32;
const SCRYPT_OPTIONS = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

function readPin(value) {
    return value === undefined || value === null ? "" : String(value).trim();
}

function isPinCredential(value) {
    return typeof value === "string" && value.startsWith(`${PREFIX}$`);
}

function createPinCredential(pin, options = {}) {
    const normalized = readPin(pin);
    if (!normalized) throw new Error("PIN_REQUIRED");
    const salt = options.salt || crypto.randomBytes(16);
    const derived = crypto.scryptSync(normalized, salt, KEY_LENGTH, SCRYPT_OPTIONS);
    return [
        PREFIX,
        SCRYPT_OPTIONS.N,
        SCRYPT_OPTIONS.r,
        SCRYPT_OPTIONS.p,
        Buffer.from(salt).toString("base64url"),
        derived.toString("base64url")
    ].join("$");
}

function parsePinCredential(value) {
    if (!isPinCredential(value)) return null;
    const parts = String(value).split("$");
    if (parts.length !== 6) return null;
    const [, rawN, rawR, rawP, rawSalt, rawHash] = parts;
    const N = Number(rawN);
    const r = Number(rawR);
    const p = Number(rawP);
    if (N !== SCRYPT_OPTIONS.N || r !== SCRYPT_OPTIONS.r || p !== SCRYPT_OPTIONS.p) return null;
    try {
        const salt = Buffer.from(rawSalt, "base64url");
        const hash = Buffer.from(rawHash, "base64url");
        if (salt.length < 16 || hash.length !== KEY_LENGTH) return null;
        return { salt, hash };
    } catch {
        return null;
    }
}

function verifyPinCredential(candidate, credential) {
    const normalized = readPin(candidate);
    const parsed = parsePinCredential(credential);
    if (!normalized || !parsed) return false;
    const derived = crypto.scryptSync(normalized, parsed.salt, parsed.hash.length, SCRYPT_OPTIONS);
    return crypto.timingSafeEqual(derived, parsed.hash);
}

module.exports = {
    PREFIX,
    createPinCredential,
    isPinCredential,
    parsePinCredential,
    verifyPinCredential
};
