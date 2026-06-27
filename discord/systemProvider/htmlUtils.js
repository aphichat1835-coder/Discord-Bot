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

function hiddenInput(name, value) {
    return `<input type="hidden" name="${escapeAttr(name)}" value="${escapeAttr(value)}">`;
}

function htmlTag(tag, attrs = {}, children = []) {
    const attrText = Object.entries(attrs)
        .filter(([, value]) => value !== undefined && value !== null && value !== false)
        .map(([key, value]) => value === true ? ` ${key}` : ` ${key}="${escapeAttr(value)}"`)
        .join("");
    return `<${tag}${attrText}>${children.join("")}</${tag}>`;
}

function safeStyleContent(value) {
    return String(value ?? "").replace(/<\/style/gi, String.raw`<\/style`);
}

module.exports = {
    escapeHtml,
    escapeAttr,
    hiddenInput,
    htmlTag,
    safeStyleContent
};
