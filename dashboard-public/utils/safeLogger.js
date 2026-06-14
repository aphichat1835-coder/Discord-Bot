const net = require("node:net");

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const IPV6_CANDIDATE_RE = /\b[0-9A-Z:.%_-]{3,}\b/gi;
const MONGO_URI_RE = /\bmongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi;
const SECRET_KV_RE = /\b(token|secret|password|webhook|authorization|dashboard_pin|pin|api_secret|internal_api_secret|encryption_key)\s*[:=]\s*["']?[^"'\s,}]+/gi;
const WEBHOOK_URL_RE = /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/[^\s"'<>]+/gi;

function redactIpv6Candidate(match) {
    const address = match.split("%")[0];
    return net.isIP(address) === 6 ? "[REDACTED_IP]" : match;
}

function isTokenChar(char) {
    const code = char.charCodeAt(0);
    return (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        char === "_" ||
        char === "-" ||
        char === ".";
}

function isDiscordTokenCandidate(value) {
    const parts = value.split(".");
    return parts.length === 3 &&
        parts[0].length >= 24 &&
        parts[1].length >= 6 &&
        parts[2].length >= 20;
}

function redactTokenCandidates(value) {
    const input = String(value ?? "");
    let output = "";
    let current = "";

    for (const char of input) {
        if (isTokenChar(char)) {
            current += char;
            continue;
        }

        output += isDiscordTokenCandidate(current) ? "[REDACTED_TOKEN]" : current;
        output += char;
        current = "";
    }

    return output + (isDiscordTokenCandidate(current) ? "[REDACTED_TOKEN]" : current);
}

function sanitizeLogText(value) {
    return redactTokenCandidates(value)
        .replace(WEBHOOK_URL_RE, "[REDACTED_WEBHOOK]")
        .replace(MONGO_URI_RE, "[REDACTED_MONGODB_URI]")
        .replace(IPV6_CANDIDATE_RE, redactIpv6Candidate)
        .replace(EMAIL_RE, "[REDACTED_EMAIL]")
        .replace(IPV4_RE, "[REDACTED_IP]")
        .replace(SECRET_KV_RE, (_match, key) => `${key}=[REDACTED_SECRET]`);
}

function safeError(err) {
    return sanitizeLogText(err?.message || err || "UNKNOWN_ERROR").slice(0, 500);
}

module.exports = {
    sanitizeLogText,
    safeError
};
