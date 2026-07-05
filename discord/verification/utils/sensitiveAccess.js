const DEFAULT_SCOPE = Object.freeze([
    'rawIp',
    'email',
    'connections',
    'guilds',
    'oauthTokens'
]);
const DEFAULT_ACCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ACCESS_LOG_LIMIT = 50;

function asNumber(value) {
    const n = Number(value || 0);
    return Number.isFinite(n) ? n : 0;
}

function normalizeScope(scope) {
    if (!Array.isArray(scope) || scope.length === 0) return [...DEFAULT_SCOPE];

    const allowed = new Set(DEFAULT_SCOPE);
    return [...new Set(scope.map(v => String(v || '').trim()).filter(v => allowed.has(v)))];
}

function normalizeSensitiveAccess(security = {}) {
    const access = security?.sensitiveDataAccess || {};
    const enabled = access.enabled === true;
    const accessLog = Array.isArray(access.accessLog)
        ? access.accessLog.slice(-ACCESS_LOG_LIMIT).map(item => ({
            accessedBy: item?.accessedBy || null,
            accessedAt: asNumber(item?.accessedAt) || null,
            scope: normalizeScope(item?.scope),
            route: item?.route || ''
        }))
        : [];

    return {
        enabled,
        scope: normalizeScope(access.scope),
        approvedBy: access.approvedBy || null,
        approvedAt: asNumber(access.approvedAt) || null,
        expiresAt: asNumber(access.expiresAt) || null,
        revokedBy: access.revokedBy || null,
        revokedAt: asNumber(access.revokedAt) || null,
        accessedBy: access.accessedBy || null,
        accessedAt: asNumber(access.accessedAt) || null,
        accessLog,
        ownerNote: access.ownerNote || '',
        updatedAt: asNumber(access.updatedAt) || null
    };
}

function canViewSensitiveData(configOrSecurity = {}) {
    const security = configOrSecurity.security || configOrSecurity || {};
    const access = normalizeSensitiveAccess(security);
    return access.enabled === true && (!access.expiresAt || access.expiresAt > Date.now());
}

function safeActorName(actor) {
    return String(actor || 'owner-dashboard').trim().slice(0, 80) || 'owner-dashboard';
}

function safeOwnerNote(ownerNote) {
    return String(ownerNote || '').trim().slice(0, 500);
}

function safeExpiresAt(value, now = Date.now()) {
    const explicit = Number(value || 0);
    if (Number.isFinite(explicit) && explicit > now) return explicit;
    return now + DEFAULT_ACCESS_TTL_MS;
}

function buildSensitiveAccessPatch({
    enabled,
    actor = 'owner-dashboard',
    ownerNote = '',
    scope,
    expiresAt
} = {}) {
    const now = Date.now();
    const safeActor = safeActorName(actor);
    const safeNote = safeOwnerNote(ownerNote);
    const safeScope = normalizeScope(scope);

    if (enabled) {
        return {
            'security.sensitiveDataAccess.enabled': true,
            'security.sensitiveDataAccess.scope': safeScope,
            'security.sensitiveDataAccess.approvedBy': safeActor,
            'security.sensitiveDataAccess.approvedAt': now,
            'security.sensitiveDataAccess.expiresAt': safeExpiresAt(expiresAt, now),
            'security.sensitiveDataAccess.revokedBy': null,
            'security.sensitiveDataAccess.revokedAt': null,
            'security.sensitiveDataAccess.ownerNote': safeNote,
            'security.sensitiveDataAccess.updatedAt': now,
            updatedAt: now
        };
    }

    return {
        'security.sensitiveDataAccess.enabled': false,
        'security.sensitiveDataAccess.revokedBy': safeActor,
        'security.sensitiveDataAccess.revokedAt': now,
        'security.sensitiveDataAccess.expiresAt': null,
        'security.sensitiveDataAccess.ownerNote': safeNote,
        'security.sensitiveDataAccess.updatedAt': now,
        updatedAt: now
    };
}

function buildSensitiveAccessAuditUpdate({ actor = 'owner-dashboard', scope, route = '' } = {}) {
    const now = Date.now();
    const safeActor = safeActorName(actor);
    const safeScope = normalizeScope(scope);
    const safeRoute = String(route || '').slice(0, 120);
    const entry = {
        accessedBy: safeActor,
        accessedAt: now,
        scope: safeScope,
        route: safeRoute
    };

    return {
        $set: {
            'security.sensitiveDataAccess.accessedBy': safeActor,
            'security.sensitiveDataAccess.accessedAt': now
        },
        $push: {
            'security.sensitiveDataAccess.accessLog': {
                $each: [entry],
                $slice: -ACCESS_LOG_LIMIT
            }
        }
    };
}

function redactSensitiveDiscordSnapshot(discord = {}, canView = false) {
    if (canView) return discord;

    return {
        ...discord,
        email: null,
        connections: [],
        guilds: []
    };
}

function redactSensitiveIpInfo(ipInfo = {}, canView = false) {
    if (canView) return ipInfo;

    return {
        ...ipInfo,
        rawIp: null,
        ip: null
    };
}

module.exports = {
    DEFAULT_SCOPE,
    DEFAULT_ACCESS_TTL_MS,
    normalizeSensitiveAccess,
    canViewSensitiveData,
    buildSensitiveAccessPatch,
    buildSensitiveAccessAuditUpdate,
    redactSensitiveDiscordSnapshot,
    redactSensitiveIpInfo
};
