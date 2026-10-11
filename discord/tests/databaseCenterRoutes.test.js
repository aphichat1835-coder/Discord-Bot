"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildDatabaseCenterPage } = require("../index/databaseCenterPage");
const { registerDatabaseRoutes } = require("../index/databaseRoutes");

test("Database Center Views & Routes Suite", async (t) => {
    await t.test("buildDatabaseCenterPage renders complete SPA markup", () => {
        const html = buildDatabaseCenterPage();
        assert.match(html, /🗄️ ศูนย์จัดการฐานข้อมูล \(Database Center\)/);
        assert.match(html, /db-tab-btn/);
        assert.match(html, /tabBtn-overview/);
        assert.match(html, /tabBtn-sqlite/);
        assert.match(html, /tabBtn-mongo/);
        assert.match(html, /switchDbTab/);
        assert.match(html, /SQLite Database Console/);
        assert.match(html, /Allowlisted Commands Only/);
        assert.match(html, /openSafeExplorer/);
    });

    await t.test("registerDatabaseRoutes registers all required API endpoints", () => {
        const routes = { get: {}, post: {} };
        const fakeApp = {
            get: (path, ...handlers) => { routes.get[path] = handlers; },
            post: (path, ...handlers) => { routes.post[path] = handlers; }
        };
        const fakeExpress = { json: () => (req, res, next) => next() };
        let authAllowed = true;
        const checkAuth = (req, res) => {
            if (!authAllowed) {
                res.status(401).json({ error: "Unauthorized" });
                return false;
            }
            return true;
        };

        registerDatabaseRoutes({ app: fakeApp, express: fakeExpress, checkAuth });

        assert.ok(routes.get["/api/database/overview"]);
        assert.ok(routes.get["/api/database/sqlite"]);
        assert.ok(routes.get["/api/database/mongo"]);
        assert.ok(routes.get["/api/database/mongo/collection/:name"]);
        assert.ok(routes.post["/api/database/sqlite/action"]);
        assert.ok(routes.post["/api/database/sqlite/console"]);
    });

    await t.test("API handlers enforce authentication and return valid data", async () => {
        const routes = { get: {}, post: {} };
        const fakeApp = {
            get: (path, ...handlers) => { routes.get[path] = handlers; },
            post: (path, ...handlers) => { routes.post[path] = handlers; }
        };
        const fakeExpress = { json: () => (req, res, next) => next() };
        let authAllowed = true;
        const checkAuth = (req, res) => {
            if (!authAllowed) {
                res.statusCode = 401;
                res.jsonPayload = { error: "Unauthorized" };
                return false;
            }
            return true;
        };

        registerDatabaseRoutes({ app: fakeApp, express: fakeExpress, checkAuth });

        function createMockRes() {
            return {
                statusCode: 200,
                jsonPayload: null,
                status(code) { this.statusCode = code; return this; },
                json(payload) { this.jsonPayload = payload; return this; }
            };
        }

        // Test unauthenticated overview
        authAllowed = false;
        const unauthRes = createMockRes();
        const overviewHandler = routes.get["/api/database/overview"].slice(-1)[0];
        await overviewHandler({}, unauthRes);
        assert.equal(unauthRes.statusCode, 401);

        // Test authenticated overview
        authAllowed = true;
        const authRes = createMockRes();
        await overviewHandler({}, authRes);
        assert.equal(authRes.statusCode, 200);
        assert.equal(authRes.jsonPayload.success, true);
        assert.ok(authRes.jsonPayload.databases);

        // Test console endpoint
        const consoleHandler = routes.post["/api/database/sqlite/console"].slice(-1)[0];
        const consoleRes = createMockRes();
        await consoleHandler({ body: { command: "status" } }, consoleRes);
        assert.equal(consoleRes.statusCode, 200);
        assert.equal(consoleRes.jsonPayload.success, true);
        assert.match(consoleRes.jsonPayload.output, /สถานะระบบฐานข้อมูล/);

        // Test action endpoint
        const actionHandler = routes.post["/api/database/sqlite/action"].slice(-1)[0];
        const actionRes = createMockRes();
        await actionHandler({ body: { action: "integrity" } }, actionRes);
        assert.equal(actionRes.statusCode, 200);
        assert.equal(actionRes.jsonPayload.success, true);
    });
});
