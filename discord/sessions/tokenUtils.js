const MIN_TOKEN_LENGTH = 50;
const MAX_TOKEN_LENGTH = 256;

function stripBase64Padding(value) {
    let clean = String(value);
    while (clean.endsWith("=")) {
        clean = clean.slice(0, -1);
    }
    return clean;
}

function toBase64Url(value) {
    return Buffer.from(String(value), "utf8")
        .toString("base64")
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
}

function isBase64UrlChar(char) {
    const code = char.codePointAt(0);
    return (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        char === "_" ||
        char === "-";
}

function isDigitsOnly(value) {
    if (!value) return false;
    for (const char of value) {
        const code = char.codePointAt(0);
        if (code < 48 || code > 57) return false;
    }
    return true;
}

function hasOnlyBase64UrlChars(value) {
    if (!value) return false;
    for (const char of value) {
        if (!isBase64UrlChar(char)) return false;
    }
    return true;
}

function isTokenPart(value, minLength, maxLength) {
    return value.length >= minLength &&
        value.length <= maxLength &&
        hasOnlyBase64UrlChars(value);
}

function decodeTokenOwnerIdSafe(token) {
    if (typeof token !== "string") return null;

    const firstPart = token.split(".")[0] || "";

    if (firstPart.length > 128 || !hasOnlyBase64UrlChars(firstPart)) {
        return null;
    }

    try {
        const padded = firstPart + "=".repeat((4 - (firstPart.length % 4)) % 4);
        const normalized = padded.replaceAll("-", "+").replaceAll("_", "/");
        const decoded = Buffer.from(normalized, "base64").toString("utf8").trim();

        if (decoded.length < 17 || decoded.length > 22 || !isDigitsOnly(decoded)) {
            return null;
        }

        const canonical = toBase64Url(decoded);

        if (canonical !== stripBase64Padding(firstPart)) {
            return null;
        }

        return decoded;
    } catch {
        return null;
    }
}

function validateTokenFormat(token) {
    if (typeof token !== "string" ||
        token.length < MIN_TOKEN_LENGTH ||
        token.length > MAX_TOKEN_LENGTH
    ) {
        return false;
    }

    const parts = token.split(".");
    return parts.length === 3 &&
        isTokenPart(parts[0], 24, 128) &&
        isTokenPart(parts[1], 6, 64) &&
        isTokenPart(parts[2], 27, 180);
}

const TOKEN_PATTERN = Object.freeze({
    test: validateTokenFormat
});

function redactToken(token) {
    if (typeof token !== "string" || !token) return "[REDACTED_TOKEN]";

    const clean = token.trim();
    if (clean.length <= 12) return "[REDACTED_TOKEN]";

    return `${clean.slice(0, 6)}...[REDACTED]...${clean.slice(-6)}`;
}

module.exports = {
    MIN_TOKEN_LENGTH,
    MAX_TOKEN_LENGTH,
    TOKEN_PATTERN,
    toBase64Url,
    decodeTokenOwnerIdSafe,
    validateTokenFormat,
    redactToken
};
