"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
    ownerGuilds,
} = require("../discord/verification/runtime");

function read(file) {
    return fs.readFileSync(path.join(process.cwd(), file), "utf8");
}

describe("single-process verification runtime contract", () => {
    test("root package has one start command and no nested dashboard service", () => {
        const pkg = require("../package.json");
        const lock = read("package-lock.json");
        expect(pkg.scripts.start).toBe("node -r ./discord/core/loadEnv discord/index.js");
        expect(pkg.dependencies).not.toHaveProperty("connect-mongo");
        expect(pkg.dependencies).not.toHaveProperty("express-session");
        expect(lock).not.toContain("connect-mongo");
        expect(lock).not.toContain("express-session");
        expect(lock).not.toContain("dashboard-public");
        expect(fs.existsSync(path.join(process.cwd(), "dashboard-public"))).toBe(false);
        expect(fs.existsSync(path.join(process.cwd(), "dashboard-public", "package.json"))).toBe(false);
    });

    test("Render blueprint defines exactly one root web service and combined health", () => {
        const render = read("render.yaml");
        expect((render.match(/^\s*-\s+type:\s+web\s*$/gm) || [])).toHaveLength(1);
        expect(render).toContain("rootDir: .");
        expect(render).toContain("startCommand: npm start");
        expect(render).toContain("healthCheckPath: /ping");
        expect(render).not.toContain("rootDir: dashboard-public");
    });

    test("normal runtime has one listener and verification does not reconnect Mongoose", () => {
        const index = read("discord/index.js");
        const verificationSources = [
            "discord/verification/runtime.js",
            "discord/verification/lifecycle.js",
            "discord/verification/routes/oauth.js",
            "discord/verification/routes/guild.js",
            "discord/verification/routes/guildDashboard.js"
        ].map(read).join("\n");
        expect((index.match(/app\.listen\(/g) || [])).toHaveLength(1);
        expect(verificationSources).not.toContain("mongoose.connect(");
        expect(index.indexOf("app.listen(")).toBeLessThan(index.indexOf("sessionManager.connectDB("));
        expect(index.indexOf("startVerificationRuntime(")).toBeLessThan(index.indexOf("startBot()"));
    });

    test("mounts public callback and owner-only management routes", () => {
        const runtime = read("discord/verification/runtime.js");
        const guild = read("discord/verification/routes/guild.js");
        expect(runtime).toContain('app.post("/auth/callback"');
        expect(runtime).toContain('app.get("/verification", ownerAuth.requirePin');
        expect(runtime).toContain('app.get("/guilds", ownerAuth.requirePin');
        expect(runtime).toContain('app.get("/guild/:guildId", ownerAuth.requirePin');
        expect(guild).toContain('router.get("/verification/:guildId"');
        expect(guild).toContain('router.get("/api/guild/:guildId/member/:userId/detail", requireAdmin, requireGuildAdmin');
        expect(guild).toContain('router.post("/api/guild/:guildId/member/:userId/reveal-token", requireAdmin, requireGuildAdmin, requireCsrf');
        expect(guild).toContain('router.get("/api/guild/:guildId/preflight", requireAdmin, requireGuildAdmin');
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
        const server = read("discord/index/server.js");
        expect(server).toContain("dbConnected");
        expect(server).toContain("botOnline");
        expect(server).toContain("voiceReady");
        expect(server).toContain("verificationReady");
        expect(server).toContain('app.get("/ready"');
        expect(server).toContain('res.redirect(307, "/health")');
    });

    test("graceful shutdown stops verification and closes HTTP and MongoDB", () => {
        const system = read("discord/index/system.js");
        expect(system).toContain("stopVerificationRuntime");
        expect(system).toContain("await closeServer()");
        expect(system).toContain("disconnectDB");
    });

    test("management routes are protected while callback remains public", () => {
        const runtime = read("discord/verification/runtime.js");
        const oauth = read("discord/verification/routes/oauth.js");
        const guild = read("discord/verification/routes/guild.js");

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
