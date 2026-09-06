const MIN_TOKEN_LENGTH = 50;
const MAX_TOKEN_LENGTH = 256;

function isBase64UrlChar(char) {
    const code = char.codePointAt(0);
    return (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        char === "_" ||
        char === "-" ||
        char === "=";
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

function cleanToken(token) {
    if (typeof token !== "string") return "";
    let clean = token.trim();
    if ((clean.startsWith('"') && clean.endsWith('"')) ||
        (clean.startsWith("'") && clean.endsWith("'"))) {
        clean = clean.slice(1, -1).trim();
    }
    return clean.replace(/^(?:Bot|Bearer)\s+/i, "").trim();
}

function validateTokenFormat(token) {
    const clean = cleanToken(token);
    if (clean.length < MIN_TOKEN_LENGTH ||
        clean.length > MAX_TOKEN_LENGTH
    ) {
        return false;
    }

    const parts = clean.split(".");
    return parts.length === 3 &&
        isTokenPart(parts[0], 20, 128) &&
        isTokenPart(parts[1], 4, 64) &&
        isTokenPart(parts[2], 20, 180);
}

const TOKEN_PATTERN = Object.freeze({
    test: validateTokenFormat
});

function redactToken(token) {
    if (typeof token !== "string" || !token) return "[REDACTED_TOKEN]";

    const clean = cleanToken(token);
    if (clean.length <= 12) return "[REDACTED_TOKEN]";

    return `${clean.slice(0, 6)}...[REDACTED]...${clean.slice(-6)}`;
}

module.exports = {
    MIN_TOKEN_LENGTH,
    MAX_TOKEN_LENGTH,
    TOKEN_PATTERN,
    cleanToken,
    validateTokenFormat,
    redactToken
};
