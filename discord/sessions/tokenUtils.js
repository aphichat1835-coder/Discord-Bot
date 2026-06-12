function toBase64Url(value) {
    return Buffer.from(String(value), "utf8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function decodeTokenOwnerIdSafe(token) {
    if (typeof token !== "string") return null;

    const firstPart = token.split(".")[0] || "";

    if (!/^[A-Za-z0-9_-]{1,128}$/.test(firstPart)) {
        return null;
    }

    try {
        const padded = firstPart + "=".repeat((4 - (firstPart.length % 4)) % 4);
        const normalized = padded.replace(/-/g, "+").replace(/_/g, "/");
        const decoded = Buffer.from(normalized, "base64").toString("utf8").trim();

        if (!/^\d{17,22}$/.test(decoded)) {
            return null;
        }

        const canonical = toBase64Url(decoded);

        if (canonical !== firstPart.replace(/=+$/g, "")) {
            return null;
        }

        return decoded;
    } catch {
        return null;
    }
}

module.exports = {
    toBase64Url,
    decodeTokenOwnerIdSafe
};
