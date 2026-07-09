"use strict";

const fs = require("node:fs");
const {
    ownerGuilds,
} = require("../discord/verification/runtime");

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
        expect(render).toContain("healthCheckPath: /ping");
        expect(render).not.toContain("rootDir: dashboard-public");
    });

    test("single-port smoke helper checks public liveness and owner boundary", () => {
        const smoke = readSmokeUnifiedRuntime();
        expect(smoke).toContain('request(baseUrl, "/ping")');
        expect(smoke).toContain('request(baseUrl, "/health")');
        expect(smoke).toContain('request(baseUrl, "/auth/callback")');
        expect(smoke).toContain('"/verification"');
        expect(smoke).toContain("isOwnerReachable");
    });

    test("docs describe production OAuth runtime requirements consistently", () => {
        const envExample = readEnvExample();
        const security = readSecurityDoc();

        expect(envExample).toContain("Required in production for signed verification state.");
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
        expect(security).toContain("public HTTPS base URL");
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
        expect(guild).toContain('router.get("/verification/:guildId"');
        expect(guild).toContain('router.get("/api/guild/:guildId/member/:userId/detail", requireAdmin, requireGuildAdmin');
        expect(guild).toContain('router.post("/api/guild/:guildId/member/:userId/reveal-token", requireAdmin, requireGuildAdmin, requireCsrf');
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

    test("combined health includes database, Discord, voice, and verification", () => {
        const server = readIndexServer();
        expect(server).toContain("dbConnected");
        expect(server).toContain("botOnline");
        expect(server).toContain("voiceReady");
        expect(server).toContain("verificationReady");
        expect(server).toContain('app.get("/ready"');
        expect(server).toContain('res.redirect(307, "/health")');
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
