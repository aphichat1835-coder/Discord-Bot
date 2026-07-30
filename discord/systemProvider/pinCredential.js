"use strict";

const crypto = require("node:crypto");

const SCHEME = "scrypt";
const VERSION = "v1";
const COST = 16384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const MAX_MEMORY = 64 * 1024 * 1024;
const PREFIX = `$${SCHEME}$${VERSION}$`;

function normalizePin(value) {
    if (value === undefined || value === null) return "";
    return String(value).trim();
}

function isPinCredential(value) {
    return typeof value === "string" && value.startsWith(PREFIX);
}

function encodeCredential({ salt, hash }) {
    return [
        "",
        SCHEME,
        VERSION,
        COST,
        BLOCK_SIZE,
        PARALLELIZATION,
        salt.toString("base64url"),
        hash.toString("base64url")
    ].join("$");
}

function parseCredential(value) {
    if (!isPinCredential(value)) return null;
    const parts = String(value).split("$");
    if (parts.length !== 8 || parts[0] !== "" || parts[1] !== SCHEME || parts[2] !== VERSION) return null;
    const cost = Number(parts[3]);
    const blockSize = Number(parts[4]);
    const parallelization = Number(parts[5]);
    if (cost !== COST || blockSize !== BLOCK_SIZE || parallelization !== PARALLELIZATION) return null;
    try {
        const salt = Buffer.from(parts[6], "base64url");
        const hash = Buffer.from(parts[7], "base64url");
        if (salt.length !== SALT_LENGTH || hash.length !== KEY_LENGTH) return null;
        return { salt, hash };
    } catch {
        return null;
    }
}

function derivePin(pin, salt) {
    return crypto.scryptSync(pin, salt, KEY_LENGTH, {
        N: COST,
        r: BLOCK_SIZE,
        p: PARALLELIZATION,
        maxmem: MAX_MEMORY
    });
}

function hashPinCredential(value) {
    const pin = normalizePin(value);
    if (pin.length < 8 || pin.length > 128) {
        const error = new Error("PIN must be between 8 and 128 characters");
        error.code = "PIN_STRENGTH_INVALID";
        throw error;
    }
    const salt = crypto.randomBytes(SALT_LENGTH);
    const hash = derivePin(pin, salt);
    return encodeCredential({ salt, hash });
}

function verifyPinCredential(candidateValue, credentialValue) {
    const candidate = normalizePin(candidateValue);
    const parsed = parseCredential(credentialValue);
    if (!candidate || !parsed) return false;
    const candidateHash = derivePin(candidate, parsed.salt);
    return crypto.timingSafeEqual(candidateHash, parsed.hash);
}

module.exports = {
    BLOCK_SIZE,
    COST,
    KEY_LENGTH,
    PARALLELIZATION,
    PREFIX,
    SALT_LENGTH,
    hashPinCredential,
    isPinCredential,
    normalizePin,
    parseCredential,
    verifyPinCredential
};