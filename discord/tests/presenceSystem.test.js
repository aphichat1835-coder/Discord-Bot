"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    STATUS_OPTIONS,
    STATUS_METADATA,
    PLATFORM_CONFIGS,
    DEFAULT_ROTATION_ITEMS,
    resolvePlatformKey,
    getPlatformProperties,
    applyDefaultPlatform,
    applyRuntimePlatform,
    PresenceScheduler,
    PresenceManager,
    presenceManager
} = require("../features/presence");

const { DefaultWebSocketManagerOptions } = require("@discordjs/ws");

test("Presence & Platform Renovation System Suite", async (t) => {
    await t.test("1. Constants & Platform Capability Specifications", () => {
        // Status checks
        assert.deepEqual(STATUS_OPTIONS, ["online", "idle", "dnd", "invisible"]);
        for (const status of STATUS_OPTIONS) {
            assert.ok(STATUS_METADATA[status], `Metadata should exist for status: ${status}`);
            assert.ok(STATUS_METADATA[status].name);
            assert.ok(STATUS_METADATA[status].color);
        }

        // Platform configs checks
        const requiredPlatforms = [
            "desktop",
            "mobile_android",
            "mobile_ios",
            "web",
            "console_ps5",
            "console_xbox",
            "vr"
        ];
        for (const p of requiredPlatforms) {
            assert.ok(PLATFORM_CONFIGS[p], `Platform config should exist for: ${p}`);
            assert.ok(PLATFORM_CONFIGS[p].properties);
            assert.ok(PLATFORM_CONFIGS[p].properties.os);
            assert.ok(PLATFORM_CONFIGS[p].properties.browser);
            assert.ok(typeof PLATFORM_CONFIGS[p].properties.device === "string");
            assert.ok(PLATFORM_CONFIGS[p].badge);
            assert.ok(PLATFORM_CONFIGS[p].indicator);
        }

        // Verified Gateway properties matching reference repositories
        assert.equal(PLATFORM_CONFIGS.mobile_android.properties.browser, "Discord Android");
        assert.equal(PLATFORM_CONFIGS.mobile_ios.properties.browser, "Discord iOS");
        assert.equal(PLATFORM_CONFIGS.web.properties.browser, "Discord Web");
        assert.equal(PLATFORM_CONFIGS.console_ps5.properties.os, "Console");
        assert.equal(PLATFORM_CONFIGS.console_ps5.properties.browser, "Discord Embedded");
        assert.equal(PLATFORM_CONFIGS.console_ps5.properties.device, "PlayStation 5");
        assert.equal(PLATFORM_CONFIGS.console_xbox.properties.os, "Console");
        assert.equal(PLATFORM_CONFIGS.console_xbox.properties.browser, "Discord Embedded");
        assert.equal(PLATFORM_CONFIGS.console_xbox.properties.device, "Xbox Series X");
        assert.equal(PLATFORM_CONFIGS.vr.properties.browser, "Discord VR");

        // Default rotation items sanity
        assert.ok(Array.isArray(DEFAULT_ROTATION_ITEMS));
        assert.ok(DEFAULT_ROTATION_ITEMS.length >= 3);
        for (const item of DEFAULT_ROTATION_ITEMS) {
            assert.ok(item.id);
            assert.ok(item.name);
            assert.ok(item.durationMinutes >= 1);
        }
    });

    await t.test("2. Gateway Platform Properties & Identification Manager", async () => {
        // applyDefaultPlatform sets DefaultWebSocketManagerOptions
        const def = applyDefaultPlatform("mobile_android");
        assert.equal(def.success, true);
        assert.equal(def.platform, "mobile_android");
        assert.equal(DefaultWebSocketManagerOptions.identifyProperties.browser, "Discord Android");

        // resolvePlatformKey fallbacks
        assert.equal(resolvePlatformKey("invalid_plat"), "desktop");
        assert.equal(resolvePlatformKey("web"), "web");

        // getPlatformProperties
        const props = getPlatformProperties("console_ps5");
        assert.equal(props.device, "PlayStation 5");

        // applyRuntimePlatform with mock Discord client
        let destroyedWith = null;
        const mockShard = {
            id: 0,
            destroy: (options) => {
                destroyedWith = options;
            }
        };
        const mockClient = {
            isReady: () => true,
            ws: {
                shards: new Map([[0, mockShard]]),
                _ws: { options: {} }
            }
        };

        // Switch to web with skipCooldown
        const resWeb = await applyRuntimePlatform(mockClient, "web", { skipCooldown: true });
        assert.equal(resWeb.success, true);
        assert.equal(resWeb.changed, true);
        assert.equal(resWeb.platform, "web");
        assert.equal(destroyedWith?.recover, 0);

        // Switching to web again returns already_active
        const resWebAgain = await applyRuntimePlatform(mockClient, "web", { skipCooldown: true });
        assert.equal(resWebAgain.success, true);
        assert.equal(resWebAgain.changed, false);
        assert.equal(resWebAgain.reason, "already_active");

        // Rapid switch without skipCooldown triggers cooldown guard
        const resFast = await applyRuntimePlatform(mockClient, "mobile_ios", { skipCooldown: false });
        assert.equal(resFast.success, false);
        assert.equal(resFast.changed, false);
        assert.match(resFast.error, /กรุณารออีก/);

        // Switch with force/skipCooldown succeeds
        const resForced = await applyRuntimePlatform(mockClient, "desktop", { skipCooldown: true, force: true });
        assert.equal(resForced.success, true);
        assert.equal(resForced.changed, true);
        assert.equal(resForced.platform, "desktop");

        // Array shards and client not ready
        const mockClientArray = {
            isReady: () => false,
            ws: {
                shards: [{ id: 0, destroy: () => {} }],
                _ws: { options: {} }
            }
        };
        const resNotReady = await applyRuntimePlatform(mockClientArray, "vr", { skipCooldown: true, force: true });
        assert.equal(resNotReady.success, true);
        assert.equal(resNotReady.reconnected, false);

        // Missing ws gracefully handled
        const resNoWs = await applyRuntimePlatform({}, "mobile_ios", { skipCooldown: true, force: true });
        assert.equal(resNoWs.success, true);

        // Shard destroy error handled gracefully
        const mockClientFail = {
            isReady: () => true,
            ws: {
                shards: [
                    {
                        id: 0,
                        destroy: () => {
                            throw new Error("Socket error");
                        }
                    }
                ],
                _ws: { options: {} }
            }
        };
        const resFail = await applyRuntimePlatform(mockClientFail, "web", { skipCooldown: true, force: true });
        assert.equal(resFail.success, true);
    });

    await t.test("3. PresenceScheduler with Independent Per-Item Timers", async () => {
        let executedSteps = [];
        const scheduler = new PresenceScheduler({
            onStep: (item) => {
                executedSteps.push(item);
            }
        });

        const testItems = [
            { id: "i1", name: "Step 1", durationMinutes: 10, status: "online", platform: "desktop", enabled: true },
            { id: "i2", name: "Step 2", durationMinutes: 5, status: "idle", platform: "mobile_android", enabled: true },
            { id: "i3", name: "Step 3 (Disabled)", durationMinutes: 3, status: "dnd", platform: "web", enabled: false },
            { id: "i4", name: "Step 4", durationMinutes: 15, status: "dnd", platform: "console_ps5", enabled: true }
        ];

        scheduler.setItems(testItems);
        assert.equal(scheduler.items.length, 4);

        // Start scheduler
        const started = await scheduler.start();
        assert.equal(started.success, true);
        assert.equal(scheduler.isRunning, true);
        assert.equal(scheduler.currentIndex, 0);
        assert.equal(scheduler.currentItem.id, "i1");
        assert.equal(scheduler.currentItem.durationMinutes, 10);
        assert.equal(executedSteps.length, 1);
        assert.equal(executedSteps[0].id, "i1");

        // Next item should skip disabled item i3 and point to i2
        const nextItem = scheduler.getNextItem();
        assert.equal(nextItem.id, "i2");

        // Scheduler state check
        const state = scheduler.getState();
        assert.equal(state.isRunning, true);
        assert.equal(state.currentItem.id, "i1");
        assert.equal(state.nextItem.id, "i2");
        assert.ok(state.remainingSeconds > 0);
        assert.ok(state.expiresAt > Date.now());

        // Step to next item manually
        await scheduler.step();
        assert.equal(scheduler.currentIndex, 1);
        assert.equal(scheduler.currentItem.id, "i2");
        assert.equal(scheduler.currentItem.durationMinutes, 5);

        // Next item after i2 should be i4 (since i3 is disabled)
        assert.equal(scheduler.getNextItem().id, "i4");

        // Step again
        await scheduler.step();
        assert.equal(scheduler.currentIndex, 3);
        assert.equal(scheduler.currentItem.id, "i4");
        assert.equal(scheduler.currentItem.durationMinutes, 15);

        // Next item wraps around to i1
        assert.equal(scheduler.getNextItem().id, "i1");

        // Stop scheduler
        scheduler.stop();
        assert.equal(scheduler.isRunning, false);
        assert.equal(scheduler.timer, null);

        // Platform items duration minimum 5 minutes guard
        const lowPlatItems = [
            { id: "low_p", name: "Low Platform", type: "platform", platform: "mobile_ios", durationMinutes: 1 }
        ];
        const sanitizedLow = scheduler.setItems(lowPlatItems);
        assert.equal(sanitizedLow[0].durationMinutes, 5);
        scheduler.setItems(testItems);

        // Repeated start/stop idempotency
        assert.equal((await scheduler.start()).success, true);
        assert.equal((await scheduler.start()).alreadyRunning, true);
        assert.equal(scheduler.stop().success, true);
        assert.equal(scheduler.stop().success, true);

        // Generation check prevents stale step from scheduling next step
        const asyncScheduler = new PresenceScheduler({
            items: testItems
        });
        asyncScheduler.isRunning = true;
        let finishStep;
        asyncScheduler.onStep = () => new Promise(resolve => { finishStep = resolve; });
        const stepPromise = asyncScheduler.executeStep(0);
        // Replace items while step is running to increment generation
        asyncScheduler.setItems(testItems);
        finishStep({ ok: true });
        const stepRes = await stepPromise;
        assert.equal(stepRes.stale, true);
        assert.equal(asyncScheduler.timer, null);
    });

    await t.test("4. PresenceManager Coordination & Database Persistence", async () => {
        const storedSettings = {
            botStatus: "dnd",
            botPlatform: "mobile_android",
            presenceRotation: {
                enabled: false,
                items: [
                    { id: "p1", name: "Custom 1", durationMinutes: 7, status: "idle", platform: "web", enabled: true },
                    { id: "p2", name: "Custom 2", durationMinutes: 12, status: "online", platform: "desktop", enabled: true }
                ]
            }
        };

        const mockSessionManager = {
            getSetting: async (key, fallback) => {
                if (key in storedSettings) return storedSettings[key];
                return fallback;
            },
            setSetting: async (key, value) => {
                storedSettings[key] = value;
                return true;
            }
        };

        let clientPresence = null;
        const mockClient = {
            isReady: () => true,
            user: {
                presence: { activities: [{ name: "Test Activity", type: 3 }] },
                setPresence: (payload) => {
                    clientPresence = payload;
                }
            },
            ws: {
                shards: new Map([[0, { id: 0, destroy: () => {} }]]),
                _ws: { options: {} }
            }
        };

        const manager = new PresenceManager();
        await manager.initialize({
            client: mockClient,
            sessionManager: mockSessionManager,
            runtimeLog: { info: () => {}, warn: () => {}, error: () => {}, success: () => {} },
            config: {}
        });

        assert.equal(manager.isInitialized, true);
        assert.equal(manager.currentStatus, "dnd");
        assert.equal(manager.currentPlatform, "mobile_android");
        assert.equal(manager.scheduler.items.length, 2);
        assert.equal(manager.scheduler.items[0].durationMinutes, 7);

        // setStatus
        const setRes = await manager.setStatus("idle");
        assert.equal(setRes.success, true);
        assert.equal(manager.currentStatus, "idle");
        assert.equal(storedSettings.botStatus, "idle");
        assert.equal(clientPresence.status, "idle");

        // Invalid status rejection
        await assert.rejects(async () => {
            await manager.setStatus("invalid_status");
        }, /Invalid status/);

        // setPlatform
        const platRes = await manager.setPlatform("web", { skipCooldown: true });
        assert.equal(platRes.success, true);
        assert.equal(platRes.changed, true);
        assert.equal(manager.currentPlatform, "web");
        assert.equal(storedSettings.botPlatform, "web");

        // Invalid platform rejection
        await assert.rejects(async () => {
            await manager.setPlatform("nintendo_switch");
        }, /Invalid platform/);

        // saveRotation
        const newRotationItems = [
            { id: "r1", name: "Morning", durationMinutes: 20, status: "online", platform: "desktop", enabled: true },
            { id: "r2", name: "Night", durationMinutes: 40, status: "idle", platform: "mobile_ios", enabled: true }
        ];
        const rotRes = await manager.saveRotation({ enabled: true, items: newRotationItems });
        assert.equal(rotRes.success, true);
        assert.equal(rotRes.enabled, true);
        assert.equal(manager.scheduler.isRunning, true);
        assert.equal(storedSettings.presenceRotation.enabled, true);
        assert.equal(storedSettings.presenceRotation.items.length, 2);

        // toggleRotation
        const toggleRes = await manager.toggleRotation();
        assert.equal(toggleRes.success, true);
        assert.equal(toggleRes.enabled, false);
        assert.equal(manager.scheduler.isRunning, false);

        // saveRotation while already running restarts cleanly with new items without stalling
        await manager.saveRotation({ enabled: true, items: newRotationItems });
        assert.equal(manager.scheduler.isRunning, true);
        const updatedItems = [
            { id: "r3", name: "Afternoon", durationMinutes: 15, status: "dnd", platform: "vr", enabled: true }
        ];
        const restartRes = await manager.saveRotation({ enabled: true, items: updatedItems });
        assert.equal(restartRes.success, true);
        assert.equal(manager.scheduler.isRunning, true);
        assert.equal(manager.scheduler.currentItem.id, "r3");
        assert.equal(manager.scheduler.currentItem.status, "dnd");

        // getState
        const state = manager.getState();
        assert.equal(state.isInitialized, true);
        assert.equal(state.currentStatus, "dnd");
        assert.equal(state.currentPlatform, "web");
        assert.ok(state.supportedPlatforms.length >= 7);
        assert.ok(state.supportedStatuses.length === 4);

        manager.stop();
    });

    await t.test("5. Admin Routes Integration for Presence & Platform Controls", async () => {
        const { registerAdminRoutes } = require("../index/adminRoutes");
        const registeredRoutes = new Map();
        const mockApp = {
            get: (path, ...handlers) => {
                registeredRoutes.set(`GET ${path}`, handlers);
            },
            post: (path, ...handlers) => {
                registeredRoutes.set(`POST ${path}`, handlers);
            },
            delete: (path, ...handlers) => {
                registeredRoutes.set(`DELETE ${path}`, handlers);
            }
        };

        const mockSessionManager = {
            getAllSettings: async () => ({}),
            getSetting: async (key, def) => def,
            setSetting: async () => true
        };

        registerAdminRoutes({
            app: mockApp,
            express: require("express"),
            sessionManager: mockSessionManager,
            voiceWorker: { applyNaturalSettings: () => {}, applyAutoDeafSettings: () => {} },
            commands: { slashCommandsData: [] },
            API_SECRET: "test_secret_123",
            checkAuth: (req, res) => {
                if (req.headers.authorization !== "test_secret_123") {
                    res.status(401).json({ success: false, error: "Unauthorized" });
                    return false;
                }
                return true;
            },
            disabledCommands: new Set(),
            commandAuditLog: []
        });

        // Verify presence endpoints are registered
        assert.ok(registeredRoutes.has("GET /api/presence"));
        assert.ok(registeredRoutes.has("POST /api/presence/status"));
        assert.ok(registeredRoutes.has("POST /api/presence/platform"));
        assert.ok(registeredRoutes.has("POST /api/presence/rotation"));
        assert.ok(registeredRoutes.has("POST /api/presence/rotation/toggle"));
        assert.ok(registeredRoutes.has("POST /api/presence"));
        assert.ok(registeredRoutes.has("POST /api/presence/rotate"));

        // Helper to invoke route handler with simulated req and res
        async function invokeRoute(method, path, body = {}, auth = "test_secret_123") {
            const handlers = registeredRoutes.get(`${method} ${path}`);
            assert.ok(handlers, `Handler for ${method} ${path} must exist`);

            const req = {
                headers: { authorization: auth },
                body
            };
            let responseJson = null;
            let responseStatus = 200;
            const res = {
                status: (code) => {
                    responseStatus = code;
                    return res;
                },
                json: (data) => {
                    responseJson = data;
                    return res;
                }
            };

            // Run through handlers (e.g. authMiddleware then endpoint)
            for (const handler of handlers) {
                let calledNext = false;
                await handler(req, res, () => {
                    calledNext = true;
                });
                if (!calledNext) break;
            }

            return { status: responseStatus, body: responseJson };
        }

        // Test GET /api/presence
        const getRes = await invokeRoute("GET", "/api/presence");
        assert.equal(getRes.status, 200);
        assert.equal(getRes.body.success, true);
        assert.ok(getRes.body.supportedPlatforms);
        assert.ok(getRes.body.supportedStatuses);

        // Test POST /api/presence/status
        const postStatusRes = await invokeRoute("POST", "/api/presence/status", { status: "dnd" });
        assert.equal(postStatusRes.status, 200);
        assert.equal(postStatusRes.body.success, true);
        assert.equal(postStatusRes.body.status, "dnd");

        // Test POST /api/presence/status with invalid status
        const postStatusBad = await invokeRoute("POST", "/api/presence/status", { status: "flying" });
        assert.equal(postStatusBad.status, 400);
        assert.equal(postStatusBad.body.success, false);

        // Test POST /api/presence/platform
        const postPlatRes = await invokeRoute("POST", "/api/presence/platform", { platform: "mobile_android", force: true });
        assert.equal(postPlatRes.status, 200);
        assert.equal(postPlatRes.body.success, true);

        // Test POST /api/presence/platform with invalid platform
        const postPlatBad = await invokeRoute("POST", "/api/presence/platform", { platform: "atari_2600" });
        assert.equal(postPlatBad.status, 400);
        assert.equal(postPlatBad.body.success, false);

        // Test POST /api/presence/rotation
        const postRotRes = await invokeRoute("POST", "/api/presence/rotation", {
            enabled: true,
            items: [
                { id: "a1", name: "Shift 1", durationMinutes: 15, status: "online", platform: "desktop", enabled: true }
            ]
        });
        assert.equal(postRotRes.status, 200);
        assert.equal(postRotRes.body.success, true);
        assert.equal(postRotRes.body.enabled, true);

        // Test POST /api/presence/rotation/toggle
        const toggleRes = await invokeRoute("POST", "/api/presence/rotation/toggle");
        assert.equal(toggleRes.status, 200);
        assert.equal(toggleRes.body.success, true);
        assert.equal(toggleRes.body.enabled, false);

        // Test legacy POST /api/presence
        const legacyPresence = await invokeRoute("POST", "/api/presence", {
            botStatus: "online",
            botActivityType: "WATCHING",
            botActivity: "ระบบจัดการสถานะ",
            botNote: "Active"
        });
        assert.equal(legacyPresence.status, 200);
        assert.equal(legacyPresence.body.success, true);

        // Test legacy POST /api/presence/rotate
        const legacyRotate = await invokeRoute("POST", "/api/presence/rotate", {
            rotateEnabled: false,
            rotateInterval: 5,
            rotateMessages: ["Msg 1", "Msg 2"]
        });
        assert.equal(legacyRotate.status, 200);
        assert.equal(legacyRotate.body.success, true);
    });

    await t.test("6. Dashboard Views Page Settings Rendering", async () => {
        const { registerViewRoutes } = require("../index/views");
        const registeredViews = new Map();
        const mockApp = {
            get: (path, ...handlers) => {
                registeredViews.set(path, handlers[handlers.length - 1]);
            }
        };

        const mockSessionManager = {
            getAllSettings: async () => ({
                botStatus: "online",
                botPlatform: "mobile_android",
                botActivity: "ระบบออนช่องเสียง",
                maxSessions: 5,
                presenceRotation: {
                    enabled: false,
                    items: DEFAULT_ROTATION_ITEMS
                }
            })
        };

        registerViewRoutes({
            app: mockApp,
            sessionManager: mockSessionManager,
            voiceWorker: {},
            commands: { slashCommandsData: [] },
            webLogs: [],
            MAX_LOGS: 100,
            client: { isReady: () => true, user: { username: "Phomueangtai Bot" } },
            API_SECRET: "test_secret",
            disabledCommands: new Set(),
            commandAuditLog: [],
            config: { limits: { maxSessions: 10, rateLimitRequests: 30 } }
        });

        const settingsHandler = registeredViews.get("/settings");
        assert.ok(settingsHandler, "/settings handler must be registered");

        let renderedHtml = "";
        const mockRes = {
            send: (html) => {
                renderedHtml = html;
            }
        };

        await settingsHandler({ session: { authenticated: true } }, mockRes);
        assert.ok(renderedHtml.length > 0);

        // Check for 3 distinct cards in HTML
        assert.match(renderedHtml, /Online Presence Status/);
        assert.match(renderedHtml, /Client Platform \/ Device Indicator/);
        assert.match(renderedHtml, /Presence & Platform Rotation Scheduler/);

        // Check for platform capabilities and badges
        assert.match(renderedHtml, /Discord Official/);
        assert.match(renderedHtml, /Official Mobile Icon/);
        assert.match(renderedHtml, /Client-Mod Indicator/);
        assert.match(renderedHtml, /Experimental Client-Mod/);

        // Check for rotation table headers and per-item timer support
        assert.match(renderedHtml, /เวลา \(นาที\)/);
        assert.match(renderedHtml, /ชื่อรายการ/);
        assert.match(renderedHtml, /Gateway Cooldown Guard/);
    });
});
