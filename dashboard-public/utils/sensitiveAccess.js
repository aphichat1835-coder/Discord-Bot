const DEFAULT_SCOPE = Object.freeze([
    'rawIp',
    'email',
    'connections',
    'guilds'
]);

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

    return {
        enabled,
        scope: normalizeScope(access.scope),
        approvedBy: access.approvedBy || null,
        approvedAt: asNumber(access.approvedAt) || null,
        revokedBy: access.revokedBy || null,
        revokedAt: asNumber(access.revokedAt) || null,
        ownerNote: access.ownerNote || '',
        updatedAt: asNumber(access.updatedAt) || null
    };
}

function canViewSensitiveData(configOrSecurity = {}) {
    const security = configOrSecurity.security || configOrSecurity || {};
    const access = normalizeSensitiveAccess(security);
    return access.enabled === true;
}

function buildSensitiveAccessPatch({ enabled, actor = 'owner-dashboard', ownerNote = '' } = {}) {
    const now = Date.now();
    const safeActor = String(actor || 'owner-dashboard').slice(0, 80);
    const safeNote = String(ownerNote || '').trim().slice(0, 500);

    if (enabled) {
        return {
            'security.sensitiveDataAccess.enabled': true,
            'security.sensitiveDataAccess.scope': [...DEFAULT_SCOPE],
            'security.sensitiveDataAccess.approvedBy': safeActor,
            'security.sensitiveDataAccess.approvedAt': now,
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
        'security.sensitiveDataAccess.ownerNote': safeNote,
        'security.sensitiveDataAccess.updatedAt': now,
        updatedAt: now
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
    normalizeSensitiveAccess,
    canViewSensitiveData,
    buildSensitiveAccessPatch,
    redactSensitiveDiscordSnapshot,
    redactSensitiveIpInfo
};
