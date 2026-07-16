"use strict";

const fs = require("node:fs");
const {
    ownerGuilds,
    serveLegacyGuildPage,
} = require("../discord/verification/runtime");
const {
    normalizeBaseUrl,
    assertSafeResolvedHost,
    isBlockedSmokeHost
} = require("../scripts/smokeUnifiedRuntime");

function readPackageLock() {
    return fs.readFileSync("package-lock.json", "utf8");
}

function readRenderBlueprint() {
    return fs.readFileSync("render.yaml", "utf8");
}

function readSmokeUnifiedRuntime() {
    return fs.readFileSync("scripts/smokeUnifiedRuntime.js", "utf8");
}

function readEnvExample() {
    return fs.readFileSync(".env.example", "utf8");
}

function readSecurityDoc() {
    return fs.readFileSync("SECURITY.md", "utf8");
}

function readDiscordIndex() {
    return fs.readFileSync("discord/index.js", "utf8");
}

function readVerificationRuntime() {
    return fs.readFileSync("discord/verification/runtime.js", "utf8");
}

function readVerificationLifecycle() {
    return fs.readFileSync("discord/verification/lifecycle.js", "utf8");
}

function readVerificationOauthRoutes() {
    return fs.readFileSync("discord/verification/routes/oauth.js", "utf8");
}

function readVerificationGuildRoutes() {
    return fs.readFileSync("discord/verification/routes/guild.js", "utf8");
}

function readVerificationGuildDashboardRoutes() {
    return fs.readFileSync("discord/verification/routes/guildDashboard.js", "utf8");
}

function readIndexServer() {
    return fs.readFileSync("discord/index/server.js", "utf8");
}

function readIndexSystem() {
    return fs.readFileSync("discord/index/system.js", "utf8");
}

function readVerifyOwnerRoutes() {
    return fs.readFileSync("discord/index/verifyOwner.js", "utf8");
}

describe("single-process verification runtime contract", () => {
    test("scopes the Owner theme away from the public verification callback", () => {
        const ownerGuildPage = fs.readFileSync("discord/verification/views/guild.html", "utf8");
        const ownerHomePage = fs.readFileSync("discord/verification/page.js", "utf8");
        const memberCallback = fs.readFileSync("discord/verification/views/callback.html", "utf8");
        expect(ownerGuildPage).toContain('body class="owner-dashboard-theme"');
        expect(ownerHomePage).toContain('body class="owner-dashboard-theme"');
        expect(memberCallback).toContain('body class="callback-page"');
        expect(memberCallback).not.toContain("owner-dashboard-theme");
    });

    test("verification pages expose responsive and accessible interaction states", () => {
        const ownerGuildPage = fs.readFileSync("discord/verification/views/guild.html", "utf8");
        const ownerHomePage = fs.readFileSync("discord/verification/page.js", "utf8");
        const guildScript = fs.readFileSync("discord/verification/public/js/guild-dashboard.js", "utf8");
        const memberCallback = fs.readFileSync("discord/verification/views/callback.html", "utf8");
        const joinCampaignPage = fs.readFileSync("discord/index/joinCampaignPage.js", "utf8");
        const styles = fs.readFileSync("discord/verification/public/css/dashboard.css", "utf8");
        const workspaceStyles = fs.readFileSync("discord/verification/public/css/workspace.css", "utf8");

        expect(ownerHomePage).toContain('id="guild-search"');
        expect(ownerHomePage).toContain('class="verification-commandbar"');
        expect(ownerHomePage).toContain("document.createElement");
        expect(ownerGuildPage).toContain('role="tablist"');
        expect(ownerGuildPage).toContain('id="guild-switcher"');
        expect(ownerGuildPage).toContain('role="dialog"');
        expect(guildScript).toContain("aria-selected");
        expect(memberCallback).toContain('aria-live="polite"');
        expect(styles).toContain("prefers-reduced-motion");
        expect(workspaceStyles).toContain("Verification Workspace 2026");
        expect(ownerHomePage).toContain('/verification-assets/css/workspace.css');
        expect(ownerGuildPage).toContain('/verification-assets/css/workspace.css');
        expect(memberCallback).toContain('/verification-assets/css/workspace.css');
        expect(joinCampaignPage).toContain('/verification-assets/css/workspace.css');
    });

    test("root package has one start command and no nested dashboard service", () => {
        const pkg = require("../package.json");
        const lock = readPackageLock();
        expect(pkg.scripts.start).toBe("node -r ./discord/core/loadEnv discord/index.js");
        expect(pkg.scripts["smoke:unified"]).toBe("node scripts/smokeUnifiedRuntime.js");
        expect(pkg.dependencies).not.toHaveProperty("connect-mongo");
        expect(pkg.dependencies).not.toHaveProperty("express-session");
        expect(lock).not.toContain("connect-mongo");
        expect(lock).not.toContain("express-session");
        expect(lock).not.toContain("dashboard-public");
        expect(fs.existsSync("dashboard-public")).toBe(false);
        expect(fs.existsSync("dashboard-public/package.json")).toBe(false);
    });

    test("Render blueprint defines exactly one root web service and combined health", () => {
        const render = readRenderBlueprint();
        expect((render.match(/^\s*-\s+type:\s+web\s*$/gm) || [])).toHaveLength(1);
        expect(render).toContain("rootDir: .");
        expect(render).toContain("startCommand: npm start");
        expect(render).toContain("healthCheckPath: /health");
        expect(render).not.toContain("rootDir: dashboard-public");
        expect((render.match(/^\s*- key: [A-Z][A-Z0-9_]*$/gm) || [])).toHaveLength(13);
        expect(render).not.toContain("DASHBOARD_PUBLIC_URL");
        expect(render).not.toContain("TRUST_PROXY_HOPS");
    });

    test("single-port smoke helper checks public liveness and owner boundary", () => {
        const smoke = readSmokeUnifiedRuntime();
        expect(smoke).toContain('request(baseUrl, "/ping")');
        expect(smoke).toContain('request(baseUrl, "/health")');
        expect(smoke).toContain('request(baseUrl, "/auth/callback")');
        expect(smoke).toContain('"/verification"');
        expect(smoke).toContain("isOwnerReachable");
    });

    test("Owner verification copy does not describe the retired sensitive approval flow", () => {
        const guildView = fs.readFileSync("discord/verification/views/guild.html", "utf8");
        const guildScript = fs.readFileSync("discord/verification/public/js/guild-dashboard.js", "utf8");
        expect(`${guildView}\n${guildScript}`).not.toMatch(/owner approval|อนุมัติ sensitive|approval หมดอายุ/i);
        expect(guildView).toContain("Member Detail");
        expect(guildView).toContain("บันทึก audit");
    });

    test("single-port smoke helper requires an exact allowlisted hostname", () => {
        const previous = process.env.SMOKE_ALLOWED_HOSTS;
        process.env.SMOKE_ALLOWED_HOSTS = "bot.example.test,second.example.test";
        try {
            expect(normalizeBaseUrl("https://bot.example.test/path")).toBe("https://bot.example.test/path");
            expect(() => normalizeBaseUrl("https://not-bot.example.test")).toThrow(/not allowlisted/);
        } finally {
            if (previous === undefined) delete process.env.SMOKE_ALLOWED_HOSTS;
            else process.env.SMOKE_ALLOWED_HOSTS = previous;
        }
    });

    test("single-port smoke helper rejects reserved literal and resolved addresses", async () => {
        expect(isBlockedSmokeHost("100.64.0.1")).toBe(true);
        expect(isBlockedSmokeHost("198.18.0.1")).toBe(true);
        expect(isBlockedSmokeHost("fc00::1")).toBe(true);
        expect(isBlockedSmokeHost("2001:db8::1")).toBe(true);

        await expect(assertSafeResolvedHost("public.example.test", async () => [
            { address: "127.0.0.1", family: 4 }
        ])).rejects.toThrow(/reserved address/);
        await expect(assertSafeResolvedHost("public.example.test", async () => [
            { address: "203.0.113.10", family: 4 }
        ])).rejects.toThrow(/reserved address/);
        await expect(assertSafeResolvedHost("public.example.test", async () => [
            { address: "8.8.8.8", family: 4 }
        ])).resolves.toHaveLength(1);
        await expect(assertSafeResolvedHost("public.example.test", async () => {
            throw new Error("dns unavailable");
        })).rejects.toThrow(/DNS resolution failed/);
    });

    test("legacy guild alias serves the requested manageable guild page", () => {
        const guildId = "123456789012345678";
        const res = {
            sendFile: jest.fn(value => value),
            redirect: jest.fn()
        };

        serveLegacyGuildPage({
            params: { guildId },
            verificationGuilds: [{ id: guildId }]
        }, res);

        expect(res.sendFile).toHaveBeenCalledWith(expect.stringMatching(/verification\/views\/guild\.html$/));
        expect(res.redirect).not.toHaveBeenCalled();
    });

    test("legacy guild alias rejects invalid or unmanaged guild ids", () => {
        const res = {
            sendFile: jest.fn(),
            redirect: jest.fn()
        };

        serveLegacyGuildPage({
            params: { guildId: "not-a-snowflake" },
            verificationGuilds: []
        }, res);

        expect(res.redirect).toHaveBeenCalledWith(302, "/verification");
        expect(res.sendFile).not.toHaveBeenCalled();
    });

    test("docs describe production OAuth runtime requirements consistently", () => {
        const envExample = readEnvExample();
        const security = readSecurityDoc();

        const expectedKeys = [
            "NODE_ENV",
            "MONGO_URI",
            "TOKEN_MANAGER",
            "DISCORD_CLIENT_ID",
            "DISCORD_CLIENT_SECRET",
            "ENCRYPTION_KEY",
            "API_SECRET",
            "VERIFY_STATE_SECRET",
            "DASHBOARD_PIN",
            "PUBLIC_BASE_URL",
            "WEBHOOK_LOG_URL",
            "ALERT_WEBHOOK_URL",
            "TRUST_PROXY"
        ];
        const configuredKeys = envExample
            .split(/\r?\n/)
            .filter(line => /^[A-Z][A-Z0-9_]*=/.test(line))
            .map(line => line.slice(0, line.indexOf("=")));
        expect(configuredKeys).toEqual(expectedKeys);
        for (const name of [
            "DASHBOARD_PIN",
            "API_SECRET",
            "VERIFY_STATE_SECRET",
            "ENCRYPTION_KEY",
            "DISCORD_CLIENT_ID",
            "DISCORD_CLIENT_SECRET"
        ]) {
            expect(security).toContain(name);
        }
        expect(security).toContain("13 owner-maintained");
        expect(security).toMatch(/public HTTPS\s+base URL/);
    });

    test("normal runtime has one listener and verification does not reconnect Mongoose", () => {
        const index = readDiscordIndex();
        const verificationSources = [
            readVerificationRuntime(),
            readVerificationLifecycle(),
            readVerificationOauthRoutes(),
            readVerificationGuildRoutes(),
            readVerificationGuildDashboardRoutes()
        ].join("\n");
        expect((index.match(/app\.listen\(/g) || [])).toHaveLength(1);
        expect(verificationSources).not.toContain("mongoose.connect(");
        expect(index.indexOf("app.listen(")).toBeLessThan(index.indexOf("sessionManager.connectDB("));
        expect(index.indexOf("startVerificationRuntime(")).toBeLessThan(index.indexOf("startBot()"));
    });

    test("mounts public callback and owner-only management routes", () => {
        const runtime = readVerificationRuntime();
        const guild = readVerificationGuildRoutes();
        const verifyOwner = readVerifyOwnerRoutes();
        expect(runtime).toContain('app.post("/auth/callback"');
        expect(runtime).toContain('app.get("/verification", ownerAuth.requirePin');
        expect(runtime).toContain('app.get("/guilds", ownerAuth.requirePin');
        expect(runtime).toContain('app.get("/guild/:guildId", ownerAuth.requirePin');
        expect(runtime).toContain('res.redirect(302, "/verification")');
        expect(guild).toContain('router.get("/verification/:guildId"');
        expect(guild).toContain('router.get("/api/guild/:guildId/member/:userId/detail", requireAdmin, requireGuildAdmin');
        expect(guild).toContain('router.get("/api/guild/:guildId/member/:userId/ip-history", requireAdmin, requireGuildAdmin');
        expect(guild).toContain('router.post("/api/guild/:guildId/member/:userId/full-detail", requireAdmin, requireGuildAdmin, requireCsrf');
        expect(guild).toContain('router.post("/api/guild/:guildId/member/:userId/reveal-token", requireAdmin, requireGuildAdmin, requireCsrf');
        expect(guild).toContain('res.set("Cache-Control", "no-store")');
        expect(guild).toContain('router.get("/api/guild/:guildId/preflight", requireAdmin, requireGuildAdmin');
        const rawIpRouteIndex = verifyOwner.indexOf('"/api/verify-owner/guild/:guildId/user/:userId/reveal-ip"');
        expect(rawIpRouteIndex).toBeGreaterThan(-1);
        const rawIpRoute = verifyOwner.slice(rawIpRouteIndex, rawIpRouteIndex + 260);
        expect(rawIpRoute).toContain("auth.requirePin");
        expect(rawIpRoute).toContain("auth.requireCsrf");
        expect(rawIpRoute).toContain("express.json()");
        expect(guild).toContain("requireCsrf");
        expect(runtime).not.toContain("/oauth/admin");
        expect(runtime).not.toContain("/auth/admin-callback");
        expect(verifyOwner).toContain("verificationOwnerService.getOverview");
        expect(verifyOwner).toContain("verificationOwnerService.getGuildStats");
        expect(verifyOwner).toContain("verificationOwnerService.getGuildMembers");
        expect(verifyOwner).not.toContain("safeQuerySuffix");
    });

    test("Owner management sees every guild cached by the bot", () => {
        const values = [
            { id: "1", name: "one", icon: null },
            { id: "2", name: "two", icon: "icon" }
        ];
        const guilds = ownerGuilds({
            guilds: { cache: { values: () => values.values() } }
        });
        expect(guilds.map(guild => guild.id)).toEqual(["1", "2"]);
        expect(guilds.every(guild => guild.canManage && guild.isOwner)).toBe(true);
    });

    test("keeps ping as liveness and exposes combined readiness on health and ready", () => {
        const server = readIndexServer();
        expect(server).toContain("dbConnected");
        expect(server).toContain("botOnline");
        expect(server).toContain("voiceReady");
        expect(server).toContain("verificationReady");
        expect(server).toContain('app.get("/ping", (req, res) => res.status(200).send("OK"))');
        expect(server).toContain('app.get("/health", sendReadiness)');
        expect(server).toContain('app.get("/ready", sendReadiness)');
        expect(server).toContain("voice?.ready === true");
        expect(server).not.toContain("sendLiveness");
        expect(server).not.toContain("alive: true");
    });

    test("graceful shutdown stops verification and closes HTTP and MongoDB", () => {
        const system = readIndexSystem();
        expect(system).toContain("stopVerificationRuntime");
        expect(system).toContain("await closeServer()");
        expect(system).toContain("disconnectDB");
    });

    test("management routes are protected while callback remains public", () => {
        const runtime = readVerificationRuntime();
        const oauth = readVerificationOauthRoutes();
        const guild = readVerificationGuildRoutes();

        const callbackMountIndex = runtime.indexOf('app.use(oauthRoutes)');
        const ownerPageIndex = runtime.indexOf('app.get("/verification", ownerAuth.requirePin');
        const ownerApiIndex = runtime.indexOf('app.get("/api/verification/diagnostics", ownerAuth.requirePin');
        const retentionIndex = runtime.indexOf('"/api/verification/retention/dry-run"');

        expect(callbackMountIndex).toBeGreaterThan(-1);
        expect(ownerPageIndex).toBeGreaterThan(callbackMountIndex);
        expect(ownerApiIndex).toBeGreaterThan(callbackMountIndex);
        expect(retentionIndex).toBeGreaterThan(callbackMountIndex);
        expect(runtime.slice(retentionIndex, retentionIndex + 220)).toContain("ownerAuth.requirePin");
        expect(runtime.slice(retentionIndex, retentionIndex + 220)).toContain("ownerAuth.requireCsrf");

        expect(oauth).toContain("router.get('/auth/callback'");
        expect(oauth).toContain("router.post('/auth/callback'");
        expect(oauth).not.toContain("requirePin");
        expect(oauth).not.toContain("requireCsrf");
        expect(guild).toContain('router.get("/api/guilds", requireAdmin');
        expect(guild).toContain("requireCsrf");
    });
});
