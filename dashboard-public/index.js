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

const express    = require('express');
const mongoose   = require('mongoose');
const session    = require('express-session');
const expressRateLimit = require('express-rate-limit');
const MongoStore = require('connect-mongo');
const path       = require('path');

const oauthRoutes              = require('./routes/oauth');
const adminSessionCompatRoutes = require('./routes/adminSessionCompat');
const guildDashboardRoutes     = require('./routes/guildDashboard');
const guildRoutes              = require('./routes/guild');
const apiRoutes                = require('./routes/api');

const rateLimit = expressRateLimit.rateLimit || expressRateLimit.default || expressRateLimit;
const ipKeyGenerator = expressRateLimit.ipKeyGenerator;

const app  = express();
const PORT = process.env.PORT || process.env.PORT_DASHBOARD || 3001;

const TRUST_PROXY = String(process.env.TRUST_PROXY || '').toLowerCase() === 'true';
const TRUST_PROXY_HOPS = Math.max(1, Math.min(5, Number(process.env.TRUST_PROXY_HOPS || 1) || 1));

app.set('trust proxy', TRUST_PROXY ? TRUST_PROXY_HOPS : false);

app.disable('x-powered-by');

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

app.use(express.json({ limit: '128kb' }));
app.use(express.urlencoded({ extended: true, limit: '128kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret:            process.env.SESSION_SECRET,
    resave:            false,
    saveUninitialized: false,
    store:             MongoStore.create({
        mongoUrl: process.env.MONGO_URI,
        touchAfter: 24 * 3600
    }),
    cookie: {
        maxAge:   24 * 60 * 60 * 1000,
        httpOnly: true,
        secure:   process.env.NODE_ENV === 'production',
        sameSite: 'lax'
    }
}));


function normalizeSocketIp(ip) {
    if (!ip) return 'unknown';

    let value = String(ip).trim();

    if (value.startsWith('::ffff:')) value = value.slice(7);
    if (value === '::1') value = '127.0.0.1';
    if (value.includes('%')) value = value.split('%')[0];

    return value || 'unknown';
}

function getRateLimitKey(req) {
    const socketIp = normalizeSocketIp(
        req.socket?.remoteAddress ||
        req.connection?.remoteAddress ||
        req.ip ||
        'unknown'
    );

    const ipKey = typeof ipKeyGenerator === 'function'
        ? ipKeyGenerator(socketIp)
        : socketIp;

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
    '/api/guild/:guildId/verify/disable'
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

app.get('/guild/:guildId', (req, res) => {
    if (!req.session?.adminUser) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'views/guild.html'));
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
    res.json({
        status: 'ok',
        service: 'dashboard-public',
        uptime: process.uptime(),
        timestamp: Date.now()
    });
});

mongoose.connect(process.env.MONGO_URI, { maxPoolSize: 5 })
    .then(() => {
        console.log('[DB] ✅ MongoDB connected');

        app.listen(PORT, '0.0.0.0', () => {
            console.log(`[DASHBOARD] 🌐 Public Dashboard → http://localhost:${PORT}`);
        });
    })
    .catch(err => {
        console.error('[DB] ❌ Failed:', err.message);
        process.exit(1);
    });
