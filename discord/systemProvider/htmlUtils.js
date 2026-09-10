"use strict";

const SAFE_HTML_NAME = /^[A-Za-z][A-Za-z0-9:_-]{0,63}$/;

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;")
        .replaceAll("'", "&#39;");
}

function escapeAttr(value) {
    return escapeHtml(value);
}

function safeHtmlName(value, fallback) {
    const candidate = String(value || "");
    return SAFE_HTML_NAME.test(candidate) ? candidate : fallback;
}

function hiddenInput(name, value) {
    const safeName = safeHtmlName(name, "value");
    return `<input type="hidden" name="${escapeAttr(safeName)}" value="${escapeAttr(value)}">`;
}

function csrfHiddenInput(token) {
    return hiddenInput("_csrf", token || "");
}

function htmlTag(tag, attrs = {}, children = []) {
    const safeTag = safeHtmlName(tag, "div");
    const attrText = Object.entries(attrs)
        .filter(([, value]) => value !== undefined && value !== null && value !== false)
        .map(([key, value]) => {
            const safeKey = safeHtmlName(key, "data-invalid");
            return value === true ? ` ${safeKey}` : ` ${safeKey}="${escapeAttr(value)}"`;
        })
        .join("");
    return `<${safeTag}${attrText}>${children.join("")}</${safeTag}>`;
}

function safeStyleContent(value) {
    return String(value ?? "").replace(/<\/style/gi, String.raw`<\/style`);
}

function nonceAttribute(nonce) {
    const safeNonce = String(nonce || "").replace(/[^A-Za-z0-9+/_=-]/g, "").slice(0, 256);
    return safeNonce ? ` nonce="${escapeAttr(safeNonce)}"` : "";
}

module.exports = {
    escapeHtml,
    escapeAttr,
    safeHtmlName,
    hiddenInput,
    csrfHiddenInput,
    htmlTag,
    safeStyleContent,
    nonceAttribute
};
