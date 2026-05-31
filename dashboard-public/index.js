/*
================================================================================
  Dashboard Public — Service 2
  Render Service แยก, port 3001
  MongoDB เดียวกับ main bot
================================================================================
*/

if (!process.env.MONGO_URI)           { console.error('[FATAL] Missing MONGO_URI');           process.exit(1); }
if (!process.env.DISCORD_CLIENT_ID)   { console.error('[FATAL] Missing DISCORD_CLIENT_ID');   process.exit(1); }
if (!process.env.DISCORD_CLIENT_SECRET){ console.error('[FATAL] Missing DISCORD_CLIENT_SECRET'); process.exit(1); }
if (!process.env.ENCRYPTION_KEY)       { console.error('[FATAL] Missing ENCRYPTION_KEY');      process.exit(1); }
if (!process.env.SESSION_SECRET)       { console.error('[FATAL] Missing SESSION_SECRET');      process.exit(1); }

const express    = require('express');
const mongoose   = require('mongoose');
const session    = require('express-session');
const MongoStore = require('connect-mongo');
const path       = require('path');

const oauthRoutes = require('./routes/oauth');
const guildRoutes = require('./routes/guild');
const apiRoutes   = require('./routes/api');

const app  = express();
const PORT = process.env.PORT_DASHBOARD || 3001;

// ── Middleware ──
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret:            process.env.SESSION_SECRET,
    resave:            false,
    saveUninitialized: false,
    store:             MongoStore.create({ mongoUrl: process.env.MONGO_URI }),
    cookie: {
        maxAge:   7 * 24 * 60 * 60 * 1000, // 7 วัน
        httpOnly: true,
        secure:   process.env.NODE_ENV === 'production',
        sameSite: 'lax'
    }
}));

// ── Routes ──
app.use('/', oauthRoutes);
app.use('/', guildRoutes);
app.use('/', apiRoutes);

// ── Static pages ──
app.get('/',        (req, res) => res.sendFile(path.join(__dirname, 'views/home.html')));
app.get('/guilds',  (req, res) => {
    if (!req.session?.adminUser) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'views/guilds.html'));
});
app.get('/guild/:guildId', (req, res) => {
    if (!req.session?.adminUser) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'views/guild.html'));
});
app.get('/logout',  (req, res) => { req.session.destroy(); res.redirect('/'); });

// ── Ping ──
app.get('/ping',   (req, res) => res.send('OK'));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Connect & Start ──
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
