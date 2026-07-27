"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { registerVerifyOwnerRoutes } = require("../index/verifyOwner");
const ownerService = require("../verification/ownerService");

function createRouteHarness() {
    const routes = new Map();
    const app = {
        get(path, ...handlers) {
            routes.set(`GET ${path}`, handlers.at(-1));
        },
        post(path, ...handlers) {
            routes.set(`POST ${path}`, handlers.at(-1));
        }
    };
    registerVerifyOwnerRoutes({
        app,
        express: { json: () => (_req, _res, next) => next() }
    });
    return routes;
}

function createResponse() {
    return {
        statusCode: 200,
        payload: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.payload = payload;
            return this;
        },
        redirect() {
            throw new Error("compatibility API must not redirect");
        }
    };
}

test("verify-owner compatibility APIs call owner services directly", async () => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const routes = createRouteHarness();
    const originals = {
        getOverview: ownerService.getOverview,
        getGuildStats: ownerService.getGuildStats,
        getGuildMembers: ownerService.getGuildMembers
    };
    const calls = [];
    ownerService.getOverview = async options => {
        calls.push(["overview", options]);
        return { success: true, route: "overview" };
    };
    ownerService.getGuildStats = async guildId => {
        calls.push(["stats", guildId]);
        return { success: true, route: "stats" };
    };
    ownerService.getGuildMembers = async (guildId, options) => {
        calls.push(["members", guildId, options]);
        return { success: true, route: "members" };
    };

    try {
        const overviewResponse = createResponse();
        await routes.get("GET /api/verify-owner/overview")(
            { query: { enabled: "all" } },
            overviewResponse
        );
        assert.equal(overviewResponse.payload.route, "overview");

        const statsResponse = createResponse();
        await routes.get("GET /api/verify-owner/guild/:guildId/stats")(
            { params: { guildId: "12345678901234567" }, query: {} },
            statsResponse
        );
        assert.equal(statsResponse.payload.route, "stats");

        const membersResponse = createResponse();
        await routes.get("GET /api/verify-owner/guild/:guildId/members")(
            { params: { guildId: "12345678901234567" }, query: { page: "2", limit: "25", q: "name" } },
            membersResponse
        );
        assert.equal(membersResponse.payload.route, "members");
        assert.deepEqual(calls, [
            ["overview", { enabled: "all" }],
            ["stats", "12345678901234567"],
            ["members", "12345678901234567", { page: 2, limit: 25, q: "name" }]
        ]);
    } finally {
        Object.assign(ownerService, originals);
    }
});

test("verify-owner compatibility APIs reject invalid guild IDs before service access", async () => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const routes = createRouteHarness();
    const response = createResponse();
    await routes.get("GET /api/verify-owner/guild/:guildId/stats")(
        { params: { guildId: "https://example.test" }, query: {} },
        response
    );
    assert.equal(response.statusCode, 400);
    assert.equal(response.payload.code, "invalid_guild_id");
});

test("verify-owner compatibility layer has no separate raw-IP reveal route", () => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const routes = createRouteHarness();
    assert.equal(routes.has("POST /api/verify-owner/guild/:guildId/user/:userId/reveal-ip"), false);
});

test("verify-owner compatibility API maps unexpected service failure to 500", async (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    t.assert.ok(true);
    const routes = createRouteHarness();
    const original = ownerService.getOverview;
    ownerService.getOverview = async () => {
        throw Object.assign(new Error("database unavailable"), { code: "database_unavailable" });
    };
    try {
        const response = createResponse();
        await routes.get("GET /api/verify-owner/overview")({ query: {} }, response);
        assert.equal(response.statusCode, 500);
        assert.equal(response.payload.code, "verification_owner_error");
    } finally {
        ownerService.getOverview = original;
    }
});
