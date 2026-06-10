/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT HARDCODE PORT — use process.env.PORT.
DO NOT REMOVE: rateLimitMiddleware, checkAuth, logIntrusion.
DO NOT REMOVE: /api/reveal-token lockout logic.
================================================================================
*/

const crypto = require("crypto");
const { WebhookClient } = require("discord.js");
const auth = require("./auth");

const revealTokenAttempts = new Map();
const REVEAL_MAX     = 5;
const REVEAL_LOCKOUT = 15 * 60 * 1000;

// ════════════════════════════════════════════════════════════════════════════
//  🚦  RATE LIMITER MIDDLEWARE
// ════════════════════════════════════════════════════════════════════════════
function createRateLimiter(requestCounts, config) {
    return function rateLimitMiddleware(req, res, next) {
        const ip = req.ip;
        const now = Date.now();
        const windowMs = config.limits.rateLimitWindowMs || 60000;
        const maxReq   = config.limits.rateLimitRequests || 5;
        const history  = (requestCounts.get(ip) || []).filter(t => now - t < windowMs);

        history.push(now);
        requestCounts.set(ip, history);

        if (history.length > maxReq) {
            logIntrusion(ip, req.path);
            return res.status(429).json({ error: "Too Many Requests" });
        }

        next();
    };
}

// ════════════════════════════════════════════════════════════════════════════
//  🔐  AUTH HELPERS
// ════════════════════════════════════════════════════════════════════════════
function makeCheckAuth(API_SECRET) {
    return function checkAuth(req, res) {
        const authHeader = req.headers.authorization || "";
        const authBuf = Buffer.from(authHeader, "utf8");
        const secBuf  = Buffer.from(API_SECRET, "utf8");

        if (authBuf.length !== secBuf.length) {
            logIntrusion(req.ip, req.path);
            res.status(401).json({ success: false, error: "Unauthorized" });
            return false;
        }

        if (!crypto.timingSafeEqual(authBuf, secBuf)) {
            logIntrusion(req.ip, req.path);
            res.status(401).json({ success: false, error: "Unauthorized" });
            return false;
        }

        return true;
    };
}

function logIntrusion(ip, path) {
    console.error(`[SECURITY] 🚨 Unauthorized access on ${path} from IP: ${ip}`);

    if (process.env.ALERT_WEBHOOK_URL) {
        try {
            const wh = new WebhookClient({ url: process.env.ALERT_WEBHOOK_URL });
            wh.send({ content: `🛑 **[INTRUSION]** \`${path}\` from \`${ip}\`` })
                .catch(() => {})
                .finally(() => wh.destroy());
        } catch (_) {}
    }
}

function makeCheckRevealPin(getWebPin) {
    return function checkRevealPin(req, res) {
        const ip  = req.ip;
        const now = Date.now();
        const rec = revealTokenAttempts.get(ip) || { count: 0, lockedUntil: 0 };

        if (rec.lockedUntil > now) {
            const mins = Math.ceil((rec.lockedUntil - now) / 60000);
            res.status(429).json({ success: false, error: `ลองผิดเกินกำหนด ล็อค ${mins} นาที` });
            return null;
        }

        const { pin } = req.body || {};
        const webPin = (typeof getWebPin === "function") ? getWebPin() : null;

        if (!webPin || pin !== webPin) {
            rec.count = (rec.count || 0) + 1;

            if (rec.count >= REVEAL_MAX) {
                rec.lockedUntil = now + REVEAL_LOCKOUT;
                rec.count = 0;
            }

            revealTokenAttempts.set(ip, rec);
            logIntrusion(ip, req.path);
            res.status(401).json({ success: false, error: "PIN ไม่ถูกต้อง" });
            return null;
        }

        revealTokenAttempts.delete(ip);
        return true;
    };
}

// ════════════════════════════════════════════════════════════════════════════
//  🧩  SAFE VOICE SESSION SERIALIZERS
// ════════════════════════════════════════════════════════════════════════════
function getSafeSessionShortId(sessionId) {
    return String(sessionId || "").replace(/^vc_/, "").slice(0, 10);
}

function getSessionAccountLabel(session) {
    if (!session) return null;

    if (session.accountGlobalName && session.accountUsername) {
        return `${session.accountGlobalName} (@${session.accountUsername})`;
    }

    return session.accountTag ||
        session.accountUsername ||
        session.accountGlobalName ||
        session.accountId ||
        null;
}

function serializeVoiceSession(session) {
    if (!session) return null;

    return {
        sessionId: session.sessionId,
        shortId: getSafeSessionShortId(session.sessionId),

        serverId: session.serverId,
        serverName: session.serverName || null,
        guildIcon: session.guildIcon || null,

        voiceId: session.voiceId,
        voiceName: session.voiceName || null,

        ownerId: session.ownerId,
        ownerTag: session.ownerTag || null,
        ownerAvatar: session.ownerAvatar || null,

        accountId: session.accountId || null,
        accountUsername: session.accountUsername || null,
        accountGlobalName: session.accountGlobalName || null,
        accountTag: session.accountTag || null,
        accountAvatar: session.accountAvatar || null,
        accountLabel: getSessionAccountLabel(session),

        startedAt: session.startedAt,
        lastActivity: session.lastActivity,
        reconnectCount: session.reconnectCount || 0,
        tokenInvalid: !!session.tokenInvalid,
        reconnecting: !!session.reconnecting,
        hasConnection: !!session.connection,
        connectionStatus: session.connection?.state?.status || null

        /*
         * Security note:
         * Do not expose token, encrypted token, tokenTail, or tokenHash here.
         */
    };
}

function getSessionTokenSafe(sessionManager, sessionId) {
    if (typeof sessionManager.getSessionToken === "function") {
        return sessionManager.getSessionToken(sessionId);
    }

    if (typeof sessionManager.getToken === "function") {
        return sessionManager.getToken(sessionId);
    }

    return null;
}

// ════════════════════════════════════════════════════════════════════════════
//  🔌  REGISTER ALL API ROUTES
// ════════════════════════════════════════════════════════════════════════════
function registerRoutes({
    app, express, config, sessionManager, voiceWorker,
    commands, webLogs, MAX_LOGS, client, botReadyAt,
    API_SECRET, getWebPin, requestCounts,
    disabledCommands, commandAuditLog, toggleCooldowns,
    startRotateTimer, setupTelemetryRouter
}) {
    const checkAuth      = makeCheckAuth(API_SECRET);
    const checkRevealPin = makeCheckRevealPin(getWebPin);
    const rateLimiter    = createRateLimiter(requestCounts, config);

    // ── PIN Authentication Routes ──
    app.get("/auth/pin", (req, res) => {
        const next = req.query.next || "/";
        res.send(auth.pinPageHTML(false, next));
    });

    app.post("/auth/pin", require("express").urlencoded({ extended: false }), (req, res) => {
        const { pin, next } = req.body || {};
        const correctPin = auth.PIN();

        if (!correctPin) return res.redirect(next || "/");

        const ip = req.ip;

        if (!app._pinAttempts) app._pinAttempts = new Map();

        const attempts = app._pinAttempts.get(ip) || {
            count: 0,
            resetAt: Date.now() + 600000
        };

        if (Date.now() > attempts.resetAt) {
            attempts.count = 0;
            attempts.resetAt = Date.now() + 600000;
        }

        if (attempts.count >= 8) {
            return res.status(429).send("Too many attempts. Wait 10 minutes.");
        }

        const pinBuf = Buffer.from(pin || "", "utf8");
        const corBuf = Buffer.from(correctPin, "utf8");
        const valid  = pinBuf.length === corBuf.length && crypto.timingSafeEqual(pinBuf, corBuf);

        if (!valid) {
            attempts.count++;
            app._pinAttempts.set(ip, attempts);
            const safeNext = (next || "/").replace(/[<>"]/g, "");
            return res.send(auth.pinPageHTML(true, safeNext));
        }

        app._pinAttempts.delete(ip);

        const token    = auth.makeToken();
        const isProd   = process.env.NODE_ENV === "production";
        const safePath = (next || "/").startsWith("/") ? next : "/";

        res.setHeader("Set-Cookie", auth.setCookieHeader(token, isProd));
        res.redirect(safePath);
    });

    app.get("/auth/logout", (req, res) => {
        res.setHeader("Set-Cookie", `${auth.COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly`);
        res.redirect("/auth/pin");
    });

    // ── Health / Ping ──
    app.get("/ping", (req, res) => res.status(200).send("OK"));

    app.get("/health", (req, res) => {
        const uptimeSec = Math.floor((Date.now() - sessionManager.systemMetrics.uptime) / 1000);

        res.json({
            status: "ok",
            uptime: uptimeSec,
            sessions: sessionManager.getAllSessions().size,
            botOnline: client?.isReady?.() ?? false
        });
    });

    // ── API Status real-time JSON (exempt from rate limiter — polled every ~5s by dashboards) ──
    app.get("/api/status", (req, res) => {
        try {
            const sessions     = Array.from(sessionManager.getAllSessions().values());
            const uptimeSec    = Math.floor((Date.now() - sessionManager.systemMetrics.uptime) / 1000);
            const mem          = process.memoryUsage();
            const voiceLogs    = voiceWorker.getVoiceLogs();
            const voiceSummary = { connect: 0, recover: 0, drop: 0, disconnect: 0, fail: 0 };

            voiceLogs.forEach(e => {
                if (voiceSummary[e.type] !== undefined) voiceSummary[e.type]++;
            });

            const totalReq    = sessionManager.systemMetrics.requests;
            const totalErr    = sessionManager.systemMetrics.errors;
            const reconnects  = sessionManager.systemMetrics.reconnects;
            const successRate = totalReq > 0
                ? (((totalReq - totalErr) / totalReq) * 100).toFixed(1)
                : "100.0";

            const recentLogs = webLogs.slice(-60).reverse();
            const readyAt = typeof botReadyAt === "function" ? botReadyAt() : botReadyAt;
            const botOnlineSec = readyAt ? Math.floor((Date.now() - readyAt) / 1000) : null;

            res.json({
                botOnline: client?.isReady?.() ?? false,
                botTag: client?.user?.tag ?? null,
                uptimeSec,
                botOnlineSec,
                sessions: sessions.length,
                maxSessions: config.limits.maxSessions,
                sessionList: sessions.map(serializeVoiceSession),
                clientPool: voiceWorker.getClientPoolSize(),
                ramMB: (mem.heapUsed / 1024 / 1024).toFixed(1),
                ramTotalMB: (mem.heapTotal / 1024 / 1024).toFixed(1),
                reconnects,
                successRate,
                voiceSummary,
                recentLogs
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ── Dashboard READ-ONLY routes (exempt from rate limiter — polled by dashboards) ──
    app.get("/api/settings/natural", (req, res) => {
        try {
            res.json({ success: true, settings: voiceWorker.getNaturalSettings() });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get("/api/settings/auto-deaf", (req, res) => {
        try {
            res.json({ success: true, settings: voiceWorker.getAutoDeafSettings() });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // ── Rate limiter for write /api routes ──
    app.use("/api", rateLimiter);

    // ── Shadow Portal ──
    if (typeof setupTelemetryRouter === "function") {
        setupTelemetryRouter(app, client, null);

    }

    // ── Session Detail API ──
    app.get("/api/session/:sessionId", (req, res) => {
        try {
            const sid = req.params.sessionId;
            const session = sessionManager.getSession(sid);

            if (!session) return res.json({ found: false });

            const allLogs = voiceWorker.getVoiceLogs();
            const sessionLogs = allLogs.filter(l => l.sessionId === sid).slice(0, 40);

            res.json({
                found: true,
                session: serializeVoiceSession(session),
                voiceLogs: sessionLogs
            });
        } catch (e) {
            res.status(500).json({ found: false, error: e.message });
        }
    });

    // ── Reveal Token APIs ──
    app.post("/api/reveal-token", express.json(), (req, res) => {
        try {
            if (!checkRevealPin(req, res)) return;

            const { sessionId } = req.body || {};
            const token = getSessionTokenSafe(sessionManager, sessionId);

            if (!token) {
                return res.status(404).json({
                    success: false,
                    error: "ไม่พบ session นี้"
                });
            }

            res.json({ success: true, token });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });
        app.post("/api/reveal-all-tokens", express.json(), (req, res) => {
        try {
            if (!checkRevealPin(req, res)) return;

            const allSessions = Array.from(sessionManager.getAllSessions().values());
            const tokens = {};

            for (const s of allSessions) {
                const tok = getSessionTokenSafe(sessionManager, s.sessionId);
                if (tok) tokens[s.sessionId] = tok;
            }

            res.json({ success: true, tokens });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // ── Stop Session ──
    app.post("/api/stop-session", express.json(), async (req, res) => {
        try {
            if (!checkAuth(req, res)) return;

            const { sessionId } = req.body || {};

            if (!sessionId) {
                return res.status(400).json({
                    success: false,
                    error: "ไม่ระบุ sessionId"
                });
            }

            const session = sessionManager.getSession(sessionId);

            if (!session) {
                return res.status(404).json({
                    success: false,
                    error: "ไม่พบ session"
                });
            }

            await voiceWorker.sendSessionStoppedDM(sessionId, "manual");
            await voiceWorker.stopSession(sessionId);

            console.log(`[DASHBOARD] 🛑 Session ${sessionId} stopped via dashboard`);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // ── Commands Status / Toggle / Audit ──
    app.get("/api/commands-status", (req, res) => {
        try {
            const allCmds = (commands.slashCommandsData || []).map(cmd => ({
                name: cmd.name,
                description: cmd.description || "",
                enabled: !disabledCommands.has(cmd.name)
            }));

            res.json({
                success: true,
                commands: allCmds,
                disabledCount: disabledCommands.size
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post("/api/commands/toggle", express.json(), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const { commandName } = req.body || {};

            if (!commandName || typeof commandName !== "string") {
                return res.status(400).json({
                    success: false,
                    error: "ไม่ระบุชื่อคำสั่ง"
                });
            }

            const exists = (commands.slashCommandsData || []).find(c => c.name === commandName);

            if (!exists) {
                return res.status(404).json({
                    success: false,
                    error: `ไม่พบคำสั่ง /${commandName}`
                });
            }

            const toggleKey   = `${req.ip}:${commandName}`;
            const lastToggle  = toggleCooldowns.get(toggleKey) || 0;
            const sinceToggle = Date.now() - lastToggle;

            if (sinceToggle < 5000) {
                const wait = ((5000 - sinceToggle) / 1000).toFixed(1);
                return res.status(429).json({
                    success: false,
                    error: `กรุณารอ ${wait}s`
                });
            }

            toggleCooldowns.set(toggleKey, Date.now());

            if (disabledCommands.has(commandName)) {
                disabledCommands.delete(commandName);
            } else {
                disabledCommands.add(commandName);
            }

            await sessionManager.setSetting("disabledCommands", [...disabledCommands]);

            const nowEnabled = !disabledCommands.has(commandName);

            if (commandAuditLog.length >= 100) commandAuditLog.shift();

            commandAuditLog.push({
                commandName,
                action: nowEnabled ? "enabled" : "disabled",
                ip: req.ip,
                timestamp: Date.now()
            });

            if (process.env.ALERT_WEBHOOK_URL) {
                try {
                    const wh = new WebhookClient({ url: process.env.ALERT_WEBHOOK_URL });
                    wh.send({
                        content: `⚡ \`/${commandName}\` ถูก**${nowEnabled ? "เปิด ✅" : "ปิด ❌"}** โดย IP \`${req.ip}\``
                    }).catch(() => {});
                    wh.destroy();
                } catch (_) {}
            }

            res.json({
                success: true,
                commandName,
                enabled: nowEnabled
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get("/api/commands-audit", (req, res) => {
        res.json({
            success: true,
            log: [...commandAuditLog].reverse()
        });
    });

    // ── Settings ──
    app.post("/api/settings", express.json(), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const {
                maxSessions,
                rateLimitRequests,
                idleTimeoutHrs,
                antiRaidEnabled
            } = req.body;

            if (maxSessions) await sessionManager.setSetting("maxSessions", maxSessions);
            if (rateLimitRequests) await sessionManager.setSetting("rateLimitRequests", rateLimitRequests);
            if (idleTimeoutHrs) await sessionManager.setSetting("idleTimeoutHrs", idleTimeoutHrs);
            if (antiRaidEnabled !== undefined) await sessionManager.setSetting("antiRaidEnabled", antiRaidEnabled);

            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // ── Presence ──
    app.post("/api/presence", express.json(), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const {
                botStatus,
                botActivityType,
                botActivity,
                botNote
            } = req.body;

            if (!["online", "idle", "dnd", "invisible"].includes(botStatus)) {
                return res.status(400).json({
                    success: false,
                    error: "สถานะไม่ถูกต้อง"
                });
            }

            if (!botActivity?.trim()) {
                return res.status(400).json({
                    success: false,
                    error: "กรุณากรอกข้อความกิจกรรม"
                });
            }

            const actType = ["WATCHING", "LISTENING", "PLAYING", "COMPETING"].includes(botActivityType)
                ? botActivityType
                : "WATCHING";

            await sessionManager.setSetting("botStatus", botStatus);
            await sessionManager.setSetting("botActivityType", actType);
            await sessionManager.setSetting("botActivity", botActivity.trim().slice(0, 128));
            await sessionManager.setSetting("botNote", (botNote || "").trim().slice(0, 128));

            if (client?.isReady?.()) {
                const activities = [
                    {
                        name: botActivity.trim().slice(0, 128),
                        type: actType
                    }
                ];

                if (botNote?.trim()) {
                    activities.push({
                        name: botNote.trim().slice(0, 128),
                        type: "CUSTOM"
                    });
                }

                client.user.setPresence({
                    status: botStatus,
                    activities
                });
            }

            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post("/api/presence/rotate", express.json(), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const {
                rotateEnabled,
                rotateInterval,
                rotateMessages
            } = req.body;

            if (typeof rotateEnabled !== "boolean") {
                return res.status(400).json({
                    success: false,
                    error: "rotateEnabled ต้องเป็น boolean"
                });
            }

            const interval = Math.max(1, parseInt(rotateInterval) || 5);
            const msgs = Array.isArray(rotateMessages)
                ? rotateMessages.map(m => String(m).trim().slice(0, 128)).filter(Boolean)
                : [];

            await sessionManager.setSetting("rotateEnabled", rotateEnabled);
            await sessionManager.setSetting("rotateInterval", interval);
            await sessionManager.setSetting("rotateMessages", msgs);

            await startRotateTimer();

            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // ── Natural Settings ──
    app.post("/api/settings/natural", express.json(), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const {
                enabled,
                intervalMs,
                durationMs
            } = req.body;

            if (typeof enabled !== "boolean") {
                return res.status(400).json({
                    success: false,
                    error: "enabled ต้องเป็น boolean"
                });
            }

            const safeInterval = Math.max(60000, parseInt(intervalMs) || 3600000);
            const safeDuration = Math.min(120000, Math.max(5000, parseInt(durationMs) || 30000));

            await sessionManager.setSetting("naturalEnabled", enabled);
            await sessionManager.setSetting("naturalIntervalMs", safeInterval);
            await sessionManager.setSetting("naturalDurationMs", safeDuration);

            voiceWorker.applyNaturalSettings({
                enabled,
                intervalMs: safeInterval,
                durationMs: safeDuration
            });

            res.json({
                success: true,
                settings: voiceWorker.getNaturalSettings()
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // ── Auto Deaf Settings ──
    app.post("/api/settings/auto-deaf", express.json(), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const {
                enabled,
                intervalMs,
                openDurationMs
            } = req.body;

            if (typeof enabled !== "boolean") {
                return res.status(400).json({
                    success: false,
                    error: "enabled ต้องเป็น boolean"
                });
            }

            const safeInterval = Math.max(60000, parseInt(intervalMs) || 3600000);
            const safeOpenDuration = Math.min(600000, Math.max(5000, parseInt(openDurationMs) || 60000));

            await sessionManager.setSetting("autoDeafEnabled", enabled);
            await sessionManager.setSetting("autoDeafIntervalMs", safeInterval);
            await sessionManager.setSetting("autoDeafOpenDurationMs", safeOpenDuration);

            voiceWorker.applyAutoDeafSettings({
                enabled,
                intervalMs: safeInterval,
                openDurationMs: safeOpenDuration
            });

            res.json({
                success: true,
                settings: voiceWorker.getAutoDeafSettings()
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // ── Whitelist ──
    app.post("/api/whitelist/add", express.json(), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const { userId } = req.body;

            if (!userId || typeof userId !== "string") {
                return res.status(400).json({
                    success: false,
                    error: "Invalid userId"
                });
            }

            await sessionManager.addWhitelist(userId, "dashboard");
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post("/api/whitelist/remove", express.json(), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const { userId } = req.body;

            if (!userId || typeof userId !== "string") {
                return res.status(400).json({
                    success: false,
                    error: "Invalid userId"
                });
            }

            await sessionManager.removeWhitelist(userId);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // ── Approved Guilds ──
    app.post("/api/approve", express.json(), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const { guildId } = req.body;

            if (!guildId || typeof guildId !== "string") {
                return res.status(400).json({
                    success: false,
                    error: "Invalid guildId"
                });
            }

            await sessionManager.ApprovedGuildModel.updateOne(
                { guildId },
                { $setOnInsert: { guildId } },
                { upsert: true }
            );

            await sessionManager.PendingGuildModel.deleteOne({ guildId });

            if (process.env.ALERT_WEBHOOK_URL) {
                try {
                    const guild = client.guilds.cache.get(guildId);
                    const wh = new WebhookClient({ url: process.env.ALERT_WEBHOOK_URL });

                    await wh.send({
                        content: `✅ **[GUILD APPROVED]** ${guild ? `${guild.name} (\`${guildId}\`)` : `\`${guildId}\``}`
                    }).catch(() => {});

                    wh.destroy();
                } catch (_) {}
            }

            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post("/api/approved/remove", express.json(), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const { guildId } = req.body;

            if (!guildId || typeof guildId !== "string") {
                return res.status(400).json({
                    success: false,
                    error: "Invalid guildId"
                });
            }

            await sessionManager.ApprovedGuildModel.deleteOne({ guildId });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post("/api/approved/kick", express.json(), async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const { guildId } = req.body;

            if (!guildId || typeof guildId !== "string") {
                return res.status(400).json({
                    success: false,
                    error: "Invalid guildId"
                });
            }

            const guild = client.guilds.cache.get(guildId);

            if (!guild) {
                return res.status(404).json({
                    success: false,
                    error: "บอทไม่ได้อยู่ใน guild นี้"
                });
            }

            const guildName = guild.name;
            const guildSessions = Array.from(sessionManager.getAllSessions().values())
                .filter(s => s.serverId === guildId);

            for (const s of guildSessions) {
                await voiceWorker.stopSession(s.sessionId).catch(() => {});
            }

            await guild.leave();
            await sessionManager.ApprovedGuildModel.deleteOne({ guildId });

            if (process.env.ALERT_WEBHOOK_URL) {
                try {
                    const wh = new WebhookClient({ url: process.env.ALERT_WEBHOOK_URL });
                    await wh.send({
                        content: `👢 **[BOT KICKED]** ${guildName} (\`${guildId}\`)`
                    }).catch(() => {});
                    wh.destroy();
                } catch (_) {}
            }

            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    setInterval(() => {
        const now = Date.now();

        for (const [ip, rec] of revealTokenAttempts.entries()) {
            if (rec.lockedUntil > 0 && rec.lockedUntil < now) {
                revealTokenAttempts.delete(ip);
            }
        }
    }, 5 * 60 * 1000);
}

module.exports = {
    registerRoutes,
    logIntrusion,
    makeCheckAuth,
    makeCheckRevealPin
};
