"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { registerViewRoutes, escapeHtml, BASE_CSS } = require("../index/views");
const { buildJoinCampaignPage } = require("../index/joinCampaignPage");
const { buildDatabaseCenterPage } = require("../index/databaseCenterPage");
const {
    registerVoiceRoutes,
    voiceSessionEnsureErrorStatus,
    handleReconnectSession
} = require("../index/voiceRoutes");

test("Views & VoiceRoutes Suite", async (t) => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    await t.test("1. View Helpers & EscapeHtml", () => {
        assert.equal(escapeHtml("<script>alert('xss')</script>"), "&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
        assert.equal(escapeHtml(null), "");
        assert.equal(escapeHtml(undefined), "");
        assert.ok(typeof BASE_CSS === "string" && BASE_CSS.length > 0);
    });

    await t.test("2. Standalone Page Builders", () => {
        const campaignHtml = buildJoinCampaignPage();
        assert.ok(typeof campaignHtml === "string");
        assert.match(campaignHtml, /แผงติดตามสถานะการดึงสมาชิก/);

        const dbCenterHtml = buildDatabaseCenterPage();
        assert.ok(typeof dbCenterHtml === "string");
        assert.match(dbCenterHtml, /ศูนย์จัดการฐานข้อมูล/);
    });

    await t.test("3. registerViewRoutes registers all dashboard routes and renders HTML", async () => {
        const routes = new Map();
        const mockApp = {
            get: (path, ...handlers) => {
                routes.set(path, handlers[handlers.length - 1]);
            }
        };

        const mockSession = {
            id: "voice_guild123_owner456",
            sessionId: "voice_guild123_owner456",
            tokenHash: "abc12345",
            serverId: "123456789012345678",
            serverName: "Test Guild",
            voiceId: "234567890123456789",
            ownerId: "345678901234567890",
            ownerTag: "TestUser#0001",
            ownerAvatar: "https://example.com/avatar.png",
            state: "connected",
            startedAt: Date.now() - 3600000,
            channelName: "General Voice",
            reconnectAttempts: 1,
            stoppedReason: null,
            connection: { ping: 42 }
        };

        const mockSessionManager = {
            getAllSettings: async () => ({
                maxSessions: 20,
                autoDeafEnabled: true,
                autoDeafIntervalMs: 3600000,
                autoDeafOpenDurationMs: 60000,
                retireEnterpriseAuditLogs: true
            }),
            getSession: (id) => (id === mockSession.id || id === mockSession.sessionId ? mockSession : null),
            getSystemMetrics: () => ({
                uptimeSec: 120,
                sessions: 1,
                maxSessions: 20,
                ramMB: 180,
                rssMB: 195
            })
        };

        const mockVoiceWorker = {
            getVoiceLogs: () => [
                { timestamp: Date.now(), level: "INFO", message: "Voice connected" }
            ]
        };

        const mockClient = {
            isReady: () => true,
            guilds: {
                cache: new Map([
                    ["123456789012345678", {
                        id: "123456789012345678",
                        name: "Alpha Guild",
                        memberCount: 150,
                        joinedTimestamp: Date.now() - 86400000
                    }]
                ])
            },
            user: { tag: "Bot#1234" }
        };

        const mockCommands = {
            list: () => [{ name: "ping", description: "Ping bot", category: "General" }]
        };

        registerViewRoutes({
            app: mockApp,
            sessionManager: mockSessionManager,
            voiceWorker: mockVoiceWorker,
            commands: mockCommands,
            webLogs: [{ timestamp: Date.now(), text: "Log entry" }],
            MAX_LOGS: 50,
            client: mockClient,
            API_SECRET: "test_secret_123",
            disabledCommands: new Set(["kick"]),
            commandAuditLog: [{ command: "ping", timestamp: Date.now() }],
            config: {
                system: { ownerId: "345678901234567890" },
                limits: { maxSessions: 20, rateLimitRequests: 100 }
            }
        });

        const registeredPaths = Array.from(routes.keys());
        assert.ok(registeredPaths.includes("/"));
        assert.ok(registeredPaths.includes("/status"));
        assert.ok(registeredPaths.includes("/settings"));
        assert.ok(registeredPaths.includes("/commands"));
        assert.ok(registeredPaths.includes("/approved"));
        assert.ok(registeredPaths.includes("/join-campaign"));
        assert.ok(registeredPaths.includes("/logs"));
        assert.ok(registeredPaths.includes("/logs/voice"));
        assert.ok(registeredPaths.includes("/docs"));
        assert.ok(registeredPaths.includes("/quests"));
        assert.ok(registeredPaths.includes("/database"));
        assert.ok(registeredPaths.includes("/session/:sessionId"));

        // Helper to invoke route handler and capture rendered HTML
        async function renderRoute(path, params = {}, query = {}) {
            const handler = routes.get(path);
            let resultHtml = "";
            const req = { params, query, headers: {} };
            const res = {
                send: (html) => { resultHtml = html; return res; },
                status: () => res
            };
            await handler(req, res);
            return resultHtml;
        }

        const homeHtml = await renderRoute("/");
        assert.match(homeHtml, /ศูนย์ควบคุมระบบ/);

        const statusHtml = await renderRoute("/status");
        assert.match(statusHtml, /สถานะระบบ/);

        const settingsHtml = await renderRoute("/settings");
        assert.match(settingsHtml, /ตั้งค่าบอท/);

        const commandsHtml = await renderRoute("/commands");
        assert.match(commandsHtml, /จัดการคำสั่ง/);

        const approvedHtml = await renderRoute("/approved");
        assert.match(approvedHtml, /เซิร์ฟเวอร์ทั้งหมด/);

        const campaignRouteHtml = await renderRoute("/join-campaign");
        assert.match(campaignRouteHtml, /แผงติดตามสถานะการดึงสมาชิก/);

        const logsHtml = await renderRoute("/logs");
        assert.match(logsHtml, /บันทึกระบบ/);

        const voiceLogsHtml = await renderRoute("/logs/voice");
        assert.match(voiceLogsHtml, /บันทึกการเชื่อมต่อเสียง/);

        const docsHtml = await renderRoute("/docs");
        assert.match(docsHtml, /Voice System/);

        const questsHtml = await renderRoute("/quests");
        assert.match(questsHtml, /บันทึกการทำ Quest อัตโนมัติ/);

        const dbRouteHtml = await renderRoute("/database");
        assert.match(dbRouteHtml, /ศูนย์จัดการฐานข้อมูล/);

        const validSessionHtml = await renderRoute("/session/:sessionId", { sessionId: mockSession.sessionId });
        assert.match(validSessionHtml, /Session Detail/);

        const missingSessionHtml = await renderRoute("/session/:sessionId", { sessionId: "non_existent_session" });
        assert.match(missingSessionHtml, /Session Detail/);

        // Test unready client on /approved
        mockClient.isReady = () => false;
        const unreadyApprovedHtml = await renderRoute("/approved");
        assert.match(unreadyApprovedHtml, /กำลังเตรียมระบบ/);
    });

    await t.test("4. voiceSessionEnsureErrorStatus status code mapping", () => {
        assert.equal(voiceSessionEnsureErrorStatus("INVALID_TOKEN_FORMAT"), 400);
        assert.equal(voiceSessionEnsureErrorStatus("INVALID_GUILD_ID"), 400);
        assert.equal(voiceSessionEnsureErrorStatus("INVALID_VOICE_CHANNEL_ID"), 400);
        assert.equal(voiceSessionEnsureErrorStatus("GUILD_NOT_FOUND"), 400);
        assert.equal(voiceSessionEnsureErrorStatus("CHANNEL_NOT_FOUND"), 400);
        assert.equal(voiceSessionEnsureErrorStatus("ALREADY_ACTIVE_IN_GUILD"), 409);
        assert.equal(voiceSessionEnsureErrorStatus("already_active_different_channel"), 409);
        assert.equal(voiceSessionEnsureErrorStatus("SESSION_LOCKED"), 409);
        assert.equal(voiceSessionEnsureErrorStatus("VOICE_QUEUE_BUSY"), 409);
        assert.equal(voiceSessionEnsureErrorStatus("DATABASE_NOT_CONNECTED"), 503);
        assert.equal(voiceSessionEnsureErrorStatus("SYSTEM_SHUTTING_DOWN"), 503);
        assert.equal(voiceSessionEnsureErrorStatus("UNKNOWN_INTERNAL_ERROR"), 500);
    });

    await t.test("5. handleReconnectSession semantics", async () => {
        let authCalled = false;
        const unauthed = await handleReconnectSession({
            req: {},
            res: {},
            checkAuth: () => { authCalled = true; return false; },
            sessionManager: {},
            voiceWorker: {}
        });
        assert.equal(authCalled, true);
        assert.equal(unauthed, undefined);

        // Missing sessionId
        let status400 = 0, json400 = null;
        await handleReconnectSession({
            req: { body: {} },
            res: {
                status: (s) => { status400 = s; return { json: (j) => { json400 = j; } }; }
            },
            checkAuth: () => true,
            sessionManager: {},
            voiceWorker: {}
        });
        assert.equal(status400, 400);
        assert.equal(json400.success, false);

        // Session not found
        let status404 = 0, json404 = null;
        await handleReconnectSession({
            req: { body: { sessionId: "missing_session_id" } },
            res: {
                status: (s) => { status404 = s; return { json: (j) => { json404 = j; } }; }
            },
            checkAuth: () => true,
            sessionManager: { getSession: () => null },
            voiceWorker: {}
        });
        assert.equal(status404, 404);
        assert.equal(json404.success, false);

        // Session reconnect success
        let json200 = null;
        const res200 = {
            status: () => res200,
            json: (j) => { json200 = j; }
        };
        await handleReconnectSession({
            req: { body: { sessionId: "valid_session_id" } },
            res: res200,
            checkAuth: () => true,
            sessionManager: { getSession: (id) => ({ id, serverId: "123", serverName: "Guild" }) },
            voiceWorker: { forceReconnectSession: async () => ({ ok: true, ready: true }) }
        });
        assert.equal(json200.success, true);
    });

    await t.test("6. registerVoiceRoutes registers routes and handles endpoints", async () => {
        const postRoutes = new Map();
        const getRoutes = new Map();

        const mockApp = {
            post: (path, ...handlers) => postRoutes.set(path, handlers[handlers.length - 1]),
            get: (path, ...handlers) => getRoutes.set(path, handlers[handlers.length - 1])
        };

        const mockExpress = {
            json: () => (req, res, next) => next?.()
        };

        const mockSession = {
            id: "sess1",
            sessionId: "sess1",
            serverId: "123",
            tokenHash: "hash123",
            voiceId: "456",
            ownerId: "789",
            channelId: "456",
            serverName: "Guild Alpha",
            state: "connected"
        };

        const mockSessionManager = {
            getSession: (id) => (id === "sess1" ? mockSession : null),
            getAllSessions: () => new Map([["sess1", mockSession]]),
            deleteSession: async () => true,
            setSetting: async () => true
        };

        const mockVoiceWorker = {
            forceReconnectSession: async () => ({ ok: true, ready: true }),
            stopSession: async () => true,
            applyAutoDeafSettings: () => {},
            applyNaturalSettings: () => {},
            getAutoDeafSettings: () => ({ enabled: true, intervalMs: 3600000, openDurationMs: 60000 }),
            getNaturalSettings: () => ({ enabled: true, minDelaySec: 30, maxDelaySec: 90 }),
            getVoiceLogs: () => [{ sessionId: "sess1", message: "voice log" }]
        };

        const mockClient = {
            users: {
                cache: new Map([["789", { id: "789", username: "Owner", tag: "Owner#0001", avatar: null }]])
            }
        };

        registerVoiceRoutes({
            app: mockApp,
            express: mockExpress,
            checkAuth: () => true,
            sessionManager: mockSessionManager,
            voiceWorker: mockVoiceWorker,
            client: mockClient,
            config: { system: { ownerId: "789" } }
        });

        assert.ok(postRoutes.has("/api/reconnect-session"));
        assert.ok(postRoutes.has("/api/voice/session/reconnect"));
        assert.ok(postRoutes.has("/api/stop-session"));
        assert.ok(postRoutes.has("/api/settings/auto-deaf"));
        assert.ok(postRoutes.has("/api/settings/natural"));
        assert.ok(getRoutes.has("/api/sessions"));
        assert.ok(getRoutes.has("/api/session/:id"));
        assert.ok(getRoutes.has("/api/voice-logs"));
        assert.ok(getRoutes.has("/api/settings/natural"));
        assert.ok(getRoutes.has("/api/settings/auto-deaf"));

        // Helper to invoke route handler and capture json
        async function callRoute(handler, req) {
            let resStatus = 200;
            let resJson = null;
            const res = {
                status: (s) => { resStatus = s; return res; },
                json: (j) => { resJson = j; return res; }
            };
            await handler(req, res);
            return { status: resStatus, body: resJson };
        }

        // Test GET /api/sessions
        const sessionsRes = await callRoute(getRoutes.get("/api/sessions"), { query: {} });
        assert.equal(sessionsRes.body.success, true);
        assert.equal(sessionsRes.body.sessions.length, 1);

        // Test GET /api/session/:id
        const sessionRes = await callRoute(getRoutes.get("/api/session/:id"), { params: { id: "sess1" } });
        assert.equal(sessionRes.body.success, true);
        assert.equal(sessionRes.body.session.sessionId, "sess1");

        // Test GET /api/voice-logs
        const voiceLogsRes = await callRoute(getRoutes.get("/api/voice-logs"), {});
        assert.ok(Array.isArray(voiceLogsRes.body));

        // Test GET /api/settings/natural
        const naturalRes = await callRoute(getRoutes.get("/api/settings/natural"), {});
        assert.equal(naturalRes.body.success, true);

        // Test GET /api/settings/auto-deaf
        const autoDeafRes = await callRoute(getRoutes.get("/api/settings/auto-deaf"), {});
        assert.equal(autoDeafRes.body.success, true);

        // Test POST /api/stop-session
        const stopRes = await callRoute(postRoutes.get("/api/stop-session"), { body: { sessionId: "sess1" } });
        assert.equal(stopRes.body.success, true);

        // Test POST /api/stop-session: missing sessionId -> 400
        const stopMissing = await callRoute(postRoutes.get("/api/stop-session"), { body: {} });
        assert.equal(stopMissing.status, 400);

        // Test POST /api/stop-session: already removed session
        const stopNotFound = await callRoute(postRoutes.get("/api/stop-session"), { body: { sessionId: "non_existent" } });
        assert.equal(stopNotFound.body.action, "already_removed");

        // Test POST /api/stop-session: stop fails -> 409
        mockVoiceWorker.stopSession = async () => false;
        const stopFailed = await callRoute(postRoutes.get("/api/stop-session"), { body: { sessionId: "sess1" } });
        assert.equal(stopFailed.status, 409);
        mockVoiceWorker.stopSession = async () => true;

        // Test POST /api/settings/auto-deaf
        const autodeafRes = await callRoute(postRoutes.get("/api/settings/auto-deaf"), {
            body: { enabled: true, intervalMs: 3600000, openDurationMs: 60000 }
        });
        assert.equal(autodeafRes.body.success, true);

        const autodeafInvalid = await callRoute(postRoutes.get("/api/settings/auto-deaf"), {
            body: { enabled: "not_a_boolean" }
        });
        assert.equal(autodeafInvalid.status, 400);

        // Test POST /api/settings/natural
        const naturalPost = await callRoute(postRoutes.get("/api/settings/natural"), {
            body: { enabled: true, intervalMs: 120000, durationMs: 15000 }
        });
        assert.equal(naturalPost.body.success, true);

        const naturalInvalid = await callRoute(postRoutes.get("/api/settings/natural"), {
            body: { enabled: "not_a_boolean" }
        });
        assert.equal(naturalInvalid.status, 400);

        // Test POST /api/voice-session/ensure
        mockVoiceWorker.ensureVoiceSession = async () => ({ ok: true, action: "created", sessionId: "sess_ensured" });
        const ensureGood = await callRoute(postRoutes.get("/api/voice-session/ensure"), {
            body: { token: "clean_token_123", guildId: "123", channelId: "456" }
        });
        assert.equal(ensureGood.body.success, true);
        assert.equal(ensureGood.body.sessionId, "sess_ensured");

        // Ensure session conflict -> 409
        mockVoiceWorker.ensureVoiceSession = async () => ({ ok: false, action: "already_active" });
        const ensureConflict = await callRoute(postRoutes.get("/api/voice-session/ensure"), {
            body: { token: "token", guildId: "123", channelId: "456" }
        });
        assert.equal(ensureConflict.status, 409);

        // Ensure session invalid format -> 400
        mockVoiceWorker.ensureVoiceSession = async () => { throw new Error("INVALID_TOKEN_FORMAT"); };
        const ensureBadToken = await callRoute(postRoutes.get("/api/voice-session/ensure"), {
            body: { token: "token", guildId: "123", channelId: "456" }
        });
        assert.equal(ensureBadToken.status, 400);

        // Test GET /api/session/:id missing -> 404
        const missingRes = await callRoute(getRoutes.get("/api/session/:id"), { params: { id: "non_existent" } });
        assert.equal(missingRes.status, 404);
    });
});
