const net = require("node:net");

const SECRET_KEYS = new Set([
    "token", "secret", "password", "webhook", "authorization",
    "dashboard_pin", "pin", "api_secret", "internal_api_secret", "encryption_key"
]);

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

function isBoundaryChar(char) {
    return !char || char.trim() === "" || "\"'<>,;()[]{}".includes(char);
}

function replaceSensitiveUrls(value, prefix, replacement, acceptUrl = () => true) {
    let output = "";
    let cursor = 0;
    const lower = value.toLowerCase();
    const lowerPrefix = prefix.toLowerCase();

    while (cursor < value.length) {
        const start = lower.indexOf(lowerPrefix, cursor);
        if (start === -1) {
            output += value.slice(cursor);
            break;
        }

        let end = start;
        while (end < value.length && !isBoundaryChar(value[end])) end++;

        const candidate = value.slice(start, end);
        output += value.slice(cursor, start);
        output += acceptUrl(candidate) ? replacement : candidate;
        cursor = end;
    }

    return output;
}

function redactWebhookUrls(value) {
    return replaceSensitiveUrls(value, "https://", "[REDACTED_WEBHOOK]", candidate => {
        let host = "";
        try {
            host = new URL(candidate).hostname.toLowerCase();
        } catch {
            return false;
        }

        return ["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"].includes(host) &&
            candidate.includes("/api/webhooks/");
    });
}

function redactMongoUris(value) {
    const withoutSrv = replaceSensitiveUrls(value, "mongodb://", "[REDACTED_MONGODB_URI]");
    return replaceSensitiveUrls(withoutSrv, "mongodb+srv://", "[REDACTED_MONGODB_URI]");
}

function isIpChar(char) {
    const code = char.charCodeAt(0);
    return (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 70) ||
        (code >= 97 && code <= 102) ||
        char === "." ||
        char === ":" ||
        char === "%" ||
        char === "_" ||
        char === "-";
}

function redactIpCandidates(value) {
    let output = "";
    let current = "";

    for (const char of value) {
        if (isIpChar(char)) {
            current += char;
            continue;
        }

        const address = current.split("%")[0];
        output += net.isIP(address) ? "[REDACTED_IP]" : current;
        output += char;
        current = "";
    }

    const address = current.split("%")[0];
    return output + (net.isIP(address) ? "[REDACTED_IP]" : current);
}

function isEmailCandidate(value) {
    const at = value.indexOf("@");
    const dot = value.lastIndexOf(".");
    return at > 0 && dot > at + 1 && dot < value.length - 2;
}

function redactEmailCandidates(value) {
    let output = "";
    let current = "";

    for (const char of value) {
        if (isBoundaryChar(char)) {
            output += isEmailCandidate(current) ? "[REDACTED_EMAIL]" : current;
            output += char;
            current = "";
            continue;
        }

        current += char;
    }

    return output + (isEmailCandidate(current) ? "[REDACTED_EMAIL]" : current);
}

function readKeyName(value, start) {
    let end = start;
    while (end < value.length) {
        const char = value[end];
        const code = char.charCodeAt(0);
        const valid = (code >= 48 && code <= 57) ||
            (code >= 65 && code <= 90) ||
            (code >= 97 && code <= 122) ||
            char === "_";
        if (!valid) break;
        end++;
    }

    return { key: value.slice(start, end).toLowerCase(), end };
}

function redactSecretValues(value) {
    let output = "";
    let index = 0;

    while (index < value.length) {
        const { key, end: keyEnd } = readKeyName(value, index);
        if (!SECRET_KEYS.has(key)) {
            output += value[index];
            index++;
            continue;
        }

        let cursor = keyEnd;
        while (value[cursor] === " ") cursor++;
        if (value[cursor] !== ":" && value[cursor] !== "=") {
            output += value.slice(index, keyEnd);
            index = keyEnd;
            continue;
        }

        const separator = value[cursor++];
        while (value[cursor] === " ") cursor++;
        const quote = value[cursor] === "\"" || value[cursor] === "'" ? value[cursor++] : "";
        let valueEnd = cursor;
        while (valueEnd < value.length) {
            if (quote && value[valueEnd] === quote) break;
            if (!quote && isBoundaryChar(value[valueEnd])) break;
            valueEnd++;
        }

        output += `${value.slice(index, keyEnd)}${separator}${quote}[REDACTED_SECRET]`;
        index = quote && value[valueEnd] === quote ? valueEnd + 1 : valueEnd;
    }

    return output;
}

function sanitizeLogText(value) {
    const withTokensRedacted = redactTokenCandidates(value);
    const withWebhooksRedacted = redactWebhookUrls(withTokensRedacted);
    const withMongoRedacted = redactMongoUris(withWebhooksRedacted);
    const withIpsRedacted = redactIpCandidates(withMongoRedacted);
    const withEmailsRedacted = redactEmailCandidates(withIpsRedacted);
    return redactSecretValues(withEmailsRedacted);
}

function safeError(err) {
    return sanitizeLogText(err?.message || err || "UNKNOWN_ERROR").slice(0, 500);
}

module.exports = {
    sanitizeLogText,
    safeError
};
