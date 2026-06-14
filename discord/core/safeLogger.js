const TOKEN_RE = /[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/g;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const IPV6_RE = /\b(?:[A-F0-9]{0,4}:){2,7}[A-F0-9]{0,4}(?:%[A-Z0-9_.-]+)?\b/gi;
const MONGO_URI_RE = /\bmongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi;
const SECRET_KV_RE = /\b(token|secret|password|webhook|authorization|dashboard_pin|pin|api_secret|internal_api_secret)\s*[:=]\s*["']?[^"'\s,}]+/gi;
const WEBHOOK_URL_RE = /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/[^\s"'<>]+/gi;

function sanitizeLogText(value) {
    return String(value ?? '')
        .replace(WEBHOOK_URL_RE, '[REDACTED_WEBHOOK]')
        .replace(MONGO_URI_RE, '[REDACTED_MONGODB_URI]')
        .replace(IPV6_RE, '[REDACTED_IP]')
        .replace(TOKEN_RE, '[REDACTED_TOKEN]')
        .replace(EMAIL_RE, '[REDACTED_EMAIL]')
        .replace(IPV4_RE, '[REDACTED_IP]')
        .replace(SECRET_KV_RE, (_match, key) => `${key}=[REDACTED_SECRET]`);
}

function safeError(err) {
    return sanitizeLogText(err?.message || err || 'UNKNOWN_ERROR').slice(0, 500);
}

function safeFields(fields = {}) {
    const out = {};
    for (const [key, value] of Object.entries(fields || {})) {
        if (value === undefined) continue;
        if (value === null || typeof value === 'number' || typeof value === 'boolean') {
            out[key] = value;
        } else {
            out[key] = sanitizeLogText(value);
        }
    }
    return out;
}

function formatStructured(level, event, fields = {}) {
    return `[${String(level || 'info').toUpperCase()}] ${sanitizeLogText(event)} ${JSON.stringify(safeFields(fields))}`;
}

function log(level, event, fields = {}) {
    const line = formatStructured(level, event, fields);
    if (level === 'error') return console.error(line);
    if (level === 'warn') return console.warn(line);
    return console.log(line);
}

module.exports = {
    sanitizeLogText,
    safeError,
    safeFields,
    formatStructured,
    info: (event, fields) => log('info', event, fields),
    warn: (event, fields) => log('warn', event, fields),
    error: (event, fields) => log('error', event, fields)
};
