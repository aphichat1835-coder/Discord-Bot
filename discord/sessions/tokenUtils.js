const MIN_TOKEN_LENGTH = 50;
const MAX_TOKEN_LENGTH = 256;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{24,128}\.[A-Za-z0-9_-]{6,64}\.[A-Za-z0-9_-]{27,180}$/;

function toBase64Url(value) {
    return Buffer.from(String(value), "utf8")
        .toString("base64")
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll(/=+$/g, "");
}

function decodeTokenOwnerIdSafe(token) {
    if (typeof token !== "string") return null;

    const firstPart = token.split(".")[0] || "";

    if (!/^[A-Za-z0-9_-]{1,128}$/.test(firstPart)) {
        return null;
    }

    try {
        const padded = firstPart + "=".repeat((4 - (firstPart.length % 4)) % 4);
        const normalized = padded.replaceAll("-", "+").replaceAll("_", "/");
        const decoded = Buffer.from(normalized, "base64").toString("utf8").trim();

        if (!/^\d{17,22}$/.test(decoded)) {
            return null;
        }

        const canonical = toBase64Url(decoded);

        if (canonical !== firstPart.replaceAll(/=+$/g, "")) {
            return null;
        }

        return decoded;
    } catch {
        return null;
    }
}

function validateTokenFormat(token) {
    return typeof token === "string" &&
        token.length >= MIN_TOKEN_LENGTH &&
        token.length <= MAX_TOKEN_LENGTH &&
        TOKEN_PATTERN.test(token);
}

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
