const MIN_TOKEN_LENGTH = 50;
const MAX_TOKEN_LENGTH = 256;

function isBase64UrlChar(char) {
    const code = char.codePointAt(0);
    return (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        char === "_" ||
        char === "-" ||
        char === "=" ||
        char === "+" ||
        char === "/";
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
    // Strip zero-width and invisible formatting characters
    clean = clean.replace(/[\u200B-\u200D\uFEFF\u2060]/g, "").trim();
    // Strip markdown codeblocks e.g. ```token``` or ```js\ntoken```
    if (clean.startsWith("```") && clean.endsWith("```")) {
        clean = clean.slice(3, -3).trim();
        clean = clean.replace(/^[a-zA-Z0-9_-]+\r?\n/, "").trim();
    }
    // Strip markdown inline code backticks e.g. `token`
    if (clean.startsWith("`") && clean.endsWith("`")) {
        clean = clean.slice(1, -1).trim();
    }
    // Strip outer matching quotes
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

    // Format 1: MFA token (mfa.<base64_payload>)
    if (clean.startsWith("mfa.")) {
        const payload = clean.slice(4);
        return payload.length >= 20 && hasOnlyBase64UrlChars(payload);
    }

    // Format 2: Standard 3-part token (<part0>.<part1>.<part2>)
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
