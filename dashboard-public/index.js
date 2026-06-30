/*
================================================================================
  Dashboard Public — Service 2 / Dashboard 3
  - OAuth2 verification
  - Guild admin dashboard
  - Internal API for owner dashboard
================================================================================
*/

if (!process.env.MONGO_URI)             { console.error('[FATAL] Missing MONGO_URI');             process.exit(1); }
if (!process.env.DISCORD_CLIENT_ID)     { console.error('[FATAL] Missing DISCORD_CLIENT_ID');     process.exit(1); }
if (!process.env.DISCORD_CLIENT_SECRET) { console.error('[FATAL] Missing DISCORD_CLIENT_SECRET'); process.exit(1); }
if (!process.env.TOKEN_MANAGER)         { console.error('[FATAL] Missing TOKEN_MANAGER');         process.exit(1); }
if (!process.env.ENCRYPTION_KEY)        { console.error('[FATAL] Missing ENCRYPTION_KEY');        process.exit(1); }
if (!process.env.SESSION_SECRET)        { console.error('[FATAL] Missing SESSION_SECRET');        process.exit(1); }

if (
    !process.env.DASHBOARD_URL &&
    !process.env.PUBLIC_DASHBOARD_URL &&
    !process.env.PUBLIC_BASE_URL &&
    !process.env.DASHBOARD_PUBLIC_URL
) {
    console.warn(
        '[WARN] DASHBOARD_URL/PUBLIC_DASHBOARD_URL/PUBLIC_BASE_URL/DASHBOARD_PUBLIC_URL not set; OAuth redirect may use localhost fallback.'
    );
}

if (!process.env.API_SECRET && !process.env.INTERNAL_API_SECRET) {
    console.warn('[WARN] API_SECRET/INTERNAL_API_SECRET not set; internal API should not be exposed publicly.');
}

const IS_PRODUCTION = String(process.env.NODE_ENV || '').trim() === 'production';

const express    = require('express');
const mongoose   = require('mongoose');
const session    = require('express-session');
const expressRateLimit = require('express-rate-limit');
const MongoStoreImport = require('connect-mongo');
const MongoStore = MongoStoreImport.default || MongoStoreImport;
if (!MongoStore || typeof MongoStore.create !== 'function') {
    console.error('[FATAL] connect-mongo MongoStore.create is not available — check connect-mongo version');
    process.exit(1);
}
const path       = require('path');
const crypto     = require('node:crypto');
const v8         = require('node:v8');

const oauthRoutes              = require('./routes/oauth');
const adminSessionCompatRoutes = require('./routes/adminSessionCompat');
const guildDashboardRoutes     = require('./routes/guildDashboard');
const guildRoutes              = require('./routes/guild');
const apiRoutes                = require('./routes/api');
const { getDiscordApiDiagnostics } = require('./utils/discordAPI');
const { getOAuthUserSummaryDiagnostics } = require('./utils/oauthUserSummary');
const {
    getOAuthRefreshConfig,
    refreshPersistedOAuthTokens
} = require('./utils/oauthTokenLifecycle');

const rateLimit = expressRateLimit.rateLimit || expressRateLimit.default || expressRateLimit;
const { getTrustedRequestIp, getIpLookupDiagnostics } = require('./utils/ipUtils');
const GuildConfig = require('./models/GuildConfig');
const VerifyLog = require('./models/VerifyLog');
const IpIdentityLink = require('./models/IpIdentityLink');
const IPRevealRequest = require('./models/IPRevealRequest');
const { safeError } = require('./utils/safeLogger');
const { setCsrfCookie } = require('./utils/csrf');
const OAuthUser = require('./models/OAuthUser');

// Startup diagnostic — ตรวจ connections schema ว่า Render ใช้โค้ดล่าสุดจริง
{
    const connPath = OAuthUser.schema.path('connections');
    const schemaType = connPath?.caster?.schema ? 'object-array' : String(connPath);
    console.log('[DIAG] OAuthUser connections schema:', schemaType);
}

const app  = express();
const PORT = process.env.PORT || process.env.PORT_DASHBOARD || 3001;
let retentionTimer = null;
let retentionMaintenanceInFlight = false;
let lastRetentionMaintenanceAt = null;
let lastRetentionMaintenanceError = null;
let lastRetentionMaintenanceSummary = null;
let lastOAuthTokenRefreshAt = null;
let lastOAuthTokenRefreshError = null;
let lastOAuthTokenRefreshSummary = null;

const TRUST_PROXY = String(process.env.TRUST_PROXY || '').toLowerCase() === 'true';
const TRUST_PROXY_HOPS = Math.max(1, Math.min(5, Number(process.env.TRUST_PROXY_HOPS || 1) || 1));
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || process.env.API_SECRET || '';
const SESSION_MAX_AGE_MS = Math.max(
    5 * 60 * 1000,
    Number(process.env.ADMIN_SESSION_MAX_AGE_MS || 24 * 60 * 60 * 1000) || 24 * 60 * 60 * 1000
);
const SESSION_ROLLING = String(process.env.ADMIN_SESSION_ROLLING || 'true').trim().toLowerCase() !== 'false';
const SESSION_TOUCH_AFTER_SEC = Math.max(
    60,
    Math.min(
        Math.floor(SESSION_MAX_AGE_MS / 1000),
        Number(process.env.ADMIN_SESSION_TOUCH_AFTER_SEC || Math.min(3600, Math.max(60, Math.floor(SESSION_MAX_AGE_MS / 4000)))) || 900
    )
);
const SESSION_COOKIE_SECURE_VALUE = String(
    process.env.ADMIN_SESSION_COOKIE_SECURE || (IS_PRODUCTION ? 'auto' : 'false')
).trim().toLowerCase();
const SESSION_COOKIE_SECURE = SESSION_COOKIE_SECURE_VALUE === 'auto'
    ? 'auto'
    : ['1', 'true', 'yes', 'on'].includes(SESSION_COOKIE_SECURE_VALUE);
const RETENTION_ERROR_MAX = Math.max(5, Number(process.env.RETENTION_ERROR_MAX || 50) || 50);
const RETENTION_CONFIG_SCAN_MAX = Math.max(
    50,
    Number(process.env.RETENTION_CONFIG_SCAN_MAX || 1000) || 1000
);

app.set('trust proxy', TRUST_PROXY ? TRUST_PROXY_HOPS : false);

app.disable('x-powered-by');

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' https://cdn.discordapp.com https://cdn.discordapp.com data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );
    next();
});

app.use(express.json({ limit: '128kb' }));
app.use(express.urlencoded({ extended: true, limit: '128kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
    etag: true,
    maxAge: process.env.STATIC_CACHE_MAX_AGE || '10m',
    setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-store');
        }
    }
}));

const sessionStore = MongoStore.create({
    mongoUrl: process.env.MONGO_URI,
    touchAfter: SESSION_TOUCH_AFTER_SEC
});

app.use(session({
    secret:            process.env.SESSION_SECRET,
    resave:            false,
    saveUninitialized: false,
    store:             sessionStore,
    rolling: SESSION_ROLLING,
    proxy: TRUST_PROXY || SESSION_COOKIE_SECURE === 'auto',
    cookie: {
        maxAge:   SESSION_MAX_AGE_MS,
        httpOnly: true,
        secure:   SESSION_COOKIE_SECURE,
        sameSite: 'lax'
    }
}));

app.use((req, res, next) => {
    setCsrfCookie(req, res);
    next();
});

function normalizeSocketIp(ip) {
    if (!ip) return 'unknown';

    let value = String(ip).trim();

    if (value.startsWith('::ffff:')) value = value.slice(7);
    if (value === '::1') value = '127.0.0.1';
    if (value.includes('%')) value = value.split('%')[0];

    if (value.startsWith('[') && value.includes(']')) {
        value = value.slice(1, value.indexOf(']'));
    } else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(value)) {
        value = value.split(':')[0];
    }

    return value || 'unknown';
}

function getRateLimitKey(req) {
    const trusted = getTrustedRequestIp(req);
    const ipKey = normalizeSocketIp(trusted.ip);

    const adminId =
        req.session?.adminUser?.id ||
        req.session?.adminUser?.userId ||
        '';

    return adminId ? `${ipKey}:${adminId}` : ipKey;
}

function rateLimitHandler(_req, res) {
    return res.status(429).json({
        success: false,
        code: 'rate_limited',
        error: 'มีการยืนยันถี่เกินไป กรุณารอสักครู่แล้วลองใหม่'
    });
}

function mb(bytes) {
    return Math.round((Number(bytes || 0) / 1024 / 1024) * 10) / 10;
}

function getMemoryDiagnostics() {
    const mem = process.memoryUsage();
    const heapStats = v8.getHeapStatistics();
    return {
        heapUsedMB: mb(mem.heapUsed),
        heapTotalMB: mb(mem.heapTotal),
        rssMB: mb(mem.rss),
        externalMB: mb(mem.external),
        arrayBuffersMB: mb(mem.arrayBuffers),
        heapSizeLimitMB: mb(heapStats.heap_size_limit),
        totalAvailableSizeMB: mb(heapStats.total_available_size),
        mallocedMemoryMB: mb(heapStats.malloced_memory),
        uptimeSec: Math.round(process.uptime())
    };
}

function getRuntimeLimitDiagnostics() {
    return {
        retentionErrorMax: RETENTION_ERROR_MAX,
        retentionConfigScanMax: RETENTION_CONFIG_SCAN_MAX,
        oauthTokenRefresh: getOAuthRefreshConfig(),
        oauthUserSummary: getOAuthUserSummaryDiagnostics()
    };
}

function summarizeOAuthRefreshHealth(summary) {
    if (!summary) return null;
    return {
        skipped: summary.skipped === true,
        reason: summary.reason || null,
        scanned: Number(summary.scanned || 0),
        refreshed: Number(summary.refreshed || 0),
        failed: Number(summary.failed || 0),
        revoked: Number(summary.revoked || 0),
        persistenceFailed: Number(summary.persistenceFailed || 0),
        errorCount: Array.isArray(summary.errors) ? summary.errors.length : 0,
        byField: Object.fromEntries(Object.entries(summary.byField || {}).map(([field, item]) => [field, {
            scanned: Number(item?.scanned || 0),
            refreshed: Number(item?.refreshed || 0),
            failed: Number(item?.failed || 0),
            revoked: Number(item?.revoked || 0),
            persistenceFailed: Number(item?.persistenceFailed || 0),
            errorCount: Array.isArray(item?.errors) ? item.errors.length : 0
        }]))
    };
}

const callbackLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: getRateLimitKey,
    handler: rateLimitHandler
});

const adminOauthLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: getRateLimitKey,
    handler: rateLimitHandler
});

const guildWriteLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: getRateLimitKey,
    handler: rateLimitHandler
});

app.post('/auth/callback', callbackLimiter);
app.get(['/oauth/admin', '/auth/admin-callback'], adminOauthLimiter);
app.use([
    '/api/guild/:guildId/settings',
    '/api/guild/:guildId/verify/validate',
    '/api/guild/:guildId/verify/panel/send',
    '/api/guild/:guildId/verify/panel/update',
    '/api/guild/:guildId/verify/disable',
    '/api/guild/:guildId/reveal-request',
    '/api/guild/:guildId/member/:userId'
], guildWriteLimiter);

/*
  Route order matters:
  1. OAuth routes create admin session
  2. Session compatibility syncs adminGuilds/adminUser shape
  3. New dashboard extension routes
  4. Existing guild admin routes
  5. Internal owner APIs
*/
app.use('/', oauthRoutes);
app.use('/', adminSessionCompatRoutes);
app.use('/', guildDashboardRoutes);
app.use('/', guildRoutes);
app.use('/', apiRoutes);

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views/home.html'));
});

app.get('/guilds', (req, res) => {
    if (!req.session?.adminUser) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'views/guilds.html'));
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

app.get('/auth/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

app.get('/ping', (_req, res) => {
    res.send('OK');
});

app.get('/health', (_req, res) => {
    const dbReady = mongoose.connection.readyState === 1;
    const configReady = Boolean(
        process.env.MONGO_URI &&
        process.env.DISCORD_CLIENT_ID &&
        process.env.DISCORD_CLIENT_SECRET &&
        process.env.TOKEN_MANAGER &&
        process.env.ENCRYPTION_KEY &&
        process.env.SESSION_SECRET
    );
    const degraded = !dbReady || !configReady;

    res.status(degraded ? 503 : 200).json({
        status: degraded ? 'degraded' : 'ok',
        db: dbReady ? 'connected' : 'disconnected',
        dbConnected: dbReady,
        config: configReady,
        uptime: process.uptime(),
        timestamp: Date.now(),
        ready: !degraded
    });
});

app.get('/ready', (_req, res) => {
    res.json({
        ready: mongoose.connection.readyState === 1,
        timestamp: Date.now()
    });
});

function retentionDays(mode) {
    const value = String(mode || '').toLowerCase();
    if (['30d', 'rolling_30d', 'delete_after_30d'].includes(value)) return 30;
    if (['90d', 'rolling_90d', 'delete_after_90d'].includes(value)) return 90;
    if (['180d', 'rolling_180d', 'delete_after_180d'].includes(value)) return 180;
    return null;
}

function requireInternalSecret(req, res, next) {
    if (!INTERNAL_SECRET) {
        return res.status(503).json({
            success: false,
            error: 'Internal API secret is not configured'
        });
    }

    const provided = String(req.headers['x-internal-secret'] || '');
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(INTERNAL_SECRET, 'utf8');

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized'
        });
    }

    return next();
}

function createRetentionSummary({ dryRun, now }) {
    return {
        dryRun,
        skipped: false,
        startedAt: now,
        finishedAt: null,
        expiredRevealRequests: 0,
        guildsScanned: 0,
        guildsWithRetention: 0,
        verifyLogs: 0,
        ipIdentityLinks: 0,
        errors: []
    };
}

async function expirePendingRevealRequests({ now, dryRun }) {
    const filter = { status: 'pending', expiresAt: { $lte: now } };

    if (dryRun) return IPRevealRequest.countDocuments(filter);

    const result = await IPRevealRequest.updateMany(
        filter,
        {
            $set: {
                status: 'expired',
                updatedAt: now,
                ownerNote: 'expired automatically'
            }
        }
    );

    return result.modifiedCount || 0;
}

function buildRetentionFilters(config, cutoff) {
    return {
        verifyLogFilter: {
            guildId: config.guildId,
            deletedAt: { $exists: false },
            $or: [
                { verifiedAt: { $lt: cutoff } },
                { createdAt: { $lt: cutoff } }
            ]
        },
        ipIdentityFilter: {
            guildId: config.guildId,
            deletedAt: { $exists: false },
            lastSeenAt: { $lt: cutoff }
        }
    };
}

async function countRetentionTargets({ verifyLogFilter, ipIdentityFilter }) {
    const [verifyLogs, ipIdentityLinks] = await Promise.all([
        VerifyLog.countDocuments(verifyLogFilter),
        IpIdentityLink.countDocuments(ipIdentityFilter)
    ]);

    return { verifyLogs, ipIdentityLinks };
}

async function softDeleteRetentionTargets({ verifyLogFilter, ipIdentityFilter, now, retentionMode }) {
    const deletedBy = `retention:${retentionMode || 'unknown'}`;
    const [verifyLogs, ipIdentityLinks] = await Promise.all([
        VerifyLog.updateMany(
            verifyLogFilter,
            {
                $set: {
                    deletedAt: now,
                    deletedBy
                }
            }
        ),
        IpIdentityLink.updateMany(
            ipIdentityFilter,
            {
                $set: {
                    deletedAt: now,
                    deletedBy,
                    updatedAt: now
                }
            }
        )
    ]);

    return {
        verifyLogs: verifyLogs.modifiedCount || 0,
        ipIdentityLinks: ipIdentityLinks.modifiedCount || 0
    };
}

function addRetentionCounts(summary, counts) {
    summary.verifyLogs += counts.verifyLogs || 0;
    summary.ipIdentityLinks += counts.ipIdentityLinks || 0;
}

function recordRetentionGuildError(summary, config, err) {
    const retentionMode = config.security?.retentionMode || 'unknown';
    const error = safeError(err);

    summary.errors.push({
        guildId: config.guildId,
        retentionMode,
        error
    });
    if (summary.errors.length > RETENTION_ERROR_MAX) {
        summary.errors.splice(0, summary.errors.length - RETENTION_ERROR_MAX);
    }

    console.error('[RETENTION] guild maintenance failed:', {
        guildId: config.guildId,
        retentionMode,
        error
    });
}

async function processRetentionGuild(config, { now, dryRun, summary }) {
    const days = retentionDays(config.security?.retentionMode);
    if (!days) return;

    summary.guildsWithRetention++;
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const filters = buildRetentionFilters(config, cutoff);

    try {
        const counts = dryRun
            ? await countRetentionTargets(filters)
            : await softDeleteRetentionTargets({
                ...filters,
                now,
                retentionMode: config.security?.retentionMode
            });
        addRetentionCounts(summary, counts);
    } catch (err) {
        recordRetentionGuildError(summary, config, err);
    }
}

async function loadRetentionConfigs() {
    return GuildConfig.find({})
        .select('guildId security.retentionMode')
        .sort({ updatedAt: -1, _id: -1 })
        .limit(RETENTION_CONFIG_SCAN_MAX)
        .lean();
}

async function runDataLifecycleMaintenance(options = {}) {
    if (retentionMaintenanceInFlight) {
        return { skipped: true, reason: 'maintenance_in_flight' };
    }

    retentionMaintenanceInFlight = true;
    lastRetentionMaintenanceError = null;
    const now = Date.now();
    const dryRun = options.dryRun === true;
    const summary = createRetentionSummary({ dryRun, now });

    try {
        summary.expiredRevealRequests = await expirePendingRevealRequests({ now, dryRun });
        const configs = await loadRetentionConfigs();
        summary.guildsScanned = configs.length;
        summary.truncated = configs.length >= RETENTION_CONFIG_SCAN_MAX;
        summary.maxGuilds = RETENTION_CONFIG_SCAN_MAX;

        for (const config of configs) {
            await processRetentionGuild(config, { now, dryRun, summary });
        }

        summary.finishedAt = Date.now();
        if (!dryRun) {
            try {
                lastOAuthTokenRefreshSummary = await refreshPersistedOAuthTokens();
                lastOAuthTokenRefreshAt = Date.now();
                lastOAuthTokenRefreshError = null;
            } catch (err) {
                lastOAuthTokenRefreshError = safeError(err);
                console.error('[OAUTH_TOKEN] refresh maintenance failed:', lastOAuthTokenRefreshError);
            }
        }

        if (!dryRun) {
            lastRetentionMaintenanceAt = summary.finishedAt;
            lastRetentionMaintenanceSummary = summary;
        }
        return summary;
    } catch (err) {
        lastRetentionMaintenanceError = safeError(err);
        throw err;
    } finally {
        retentionMaintenanceInFlight = false;
    }
}

app.get('/internal/retention/dry-run', requireInternalSecret, async (_req, res) => {
    try {
        const summary = await runDataLifecycleMaintenance({ dryRun: true });
        return res.json({ success: true, summary });
    } catch (err) {
        return res.status(500).json({
            success: false,
            error: safeError(err)
        });
    }
});

app.get('/internal/diagnostics', requireInternalSecret, (_req, res) => {
    res.json({
        success: true,
        service: 'dashboard-public',
        timestamp: Date.now(),
        memory: getMemoryDiagnostics(),
        runtimeLimits: getRuntimeLimitDiagnostics(),
        database: {
            connected: mongoose.connection.readyState === 1,
            readyState: mongoose.connection.readyState,
            name: mongoose.connection.name || null
        },
        session: {
            store: sessionStore?.constructor?.name || 'unknown',
            rolling: SESSION_ROLLING,
            maxAgeMs: SESSION_MAX_AGE_MS,
            touchAfterSec: SESSION_TOUCH_AFTER_SEC,
            secure: SESSION_COOKIE_SECURE,
            proxy: TRUST_PROXY || SESSION_COOKIE_SECURE === 'auto'
        },
        discordApi: getDiscordApiDiagnostics(),
        ipLookup: getIpLookupDiagnostics(),
        retention: {
            timerActive: !!retentionTimer,
            inFlight: retentionMaintenanceInFlight,
            lastRunAt: lastRetentionMaintenanceAt,
            lastError: lastRetentionMaintenanceError,
            lastSummary: lastRetentionMaintenanceSummary
        },
        oauthTokenRefresh: {
            config: getOAuthRefreshConfig(),
            lastRunAt: lastOAuthTokenRefreshAt,
            lastError: lastOAuthTokenRefreshError,
            lastSummary: summarizeOAuthRefreshHealth(lastOAuthTokenRefreshSummary)
        }
    });
});

function stopRetentionMaintenance() {
    if (!retentionTimer) return;
    clearInterval(retentionTimer);
    retentionTimer = null;
}

mongoose.connect(process.env.MONGO_URI, { maxPoolSize: 5 })
    .then(() => {
        console.log('[DB] ✅ MongoDB connected');

        app.listen(PORT, '0.0.0.0', () => {
            console.log(`[DASHBOARD] 🌐 Public Dashboard → http://localhost:${PORT}`);
        });

        runDataLifecycleMaintenance().catch(err => {
            console.error('[RETENTION] maintenance failed:', safeError(err));
        });
        retentionTimer = setInterval(() => {
            runDataLifecycleMaintenance().catch(err => {
                console.error('[RETENTION] maintenance failed:', safeError(err));
            });
        }, 60 * 60 * 1000);
        retentionTimer.unref?.();
    })
    .catch(err => {
        console.error('[DB] ❌ Failed:', safeError(err));
        process.exit(1);
    });

for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
        stopRetentionMaintenance();
        mongoose.connection.close(false).finally(() => process.exit(0));
    });
}
