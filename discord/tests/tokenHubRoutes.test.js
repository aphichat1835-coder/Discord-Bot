'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerAdminRoutes } = require('../index/adminRoutes');
const tokenCoordinator = require('../core/tokenCoordinator');

function createMockApp() {
    const routes = [];
    const app = {
        get(path, ...handlers) {
            routes.push({ method: 'GET', path, handler: handlers[handlers.length - 1] });
        },
        post(path, ...handlers) {
            routes.push({ method: 'POST', path, handler: handlers[handlers.length - 1] });
        },
        delete(path, ...handlers) {
            routes.push({ method: 'DELETE', path, handler: handlers[handlers.length - 1] });
        }
    };
    return { app, routes };
}

function responseRecorder() {
    return {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(data) {
            this.body = data;
            return this;
        }
    };
}

test.beforeEach(() => {
    tokenCoordinator.reset();
});

test('token hub routes are registered properly and respond to authenticated requests', async () => {
    const { app, routes } = createMockApp();
    let authPassed = true;

    registerAdminRoutes({
        app,
        express,
        sessionManager: {},
        voiceWorker: {},
        commands: {},
        client: {},
        checkAuth: (req, res) => {
            if (!authPassed) {
                res.status(401).json({ error: 'unauthorized' });
                return false;
            }
            return true;
        },
        disabledCommands: new Set(),
        commandAuditLog: [],
        toggleCooldowns: new Map(),
        startRotateTimer: () => {},
        ROTATE_MESSAGES_MAX: 10
    });

    const statusRoute = routes.find(r => r.method === 'GET' && r.path === '/api/token-hub/status');
    const releaseRoute = routes.find(r => r.method === 'POST' && r.path === '/api/token-hub/quarantine/release');
    const clearRoute = routes.find(r => r.method === 'POST' && r.path === '/api/token-hub/cache/clear');

    assert.ok(statusRoute, 'GET /api/token-hub/status must be registered');
    assert.ok(releaseRoute, 'POST /api/token-hub/quarantine/release must be registered');
    assert.ok(clearRoute, 'POST /api/token-hub/cache/clear must be registered');

    // Test 1: Unauthenticated request is rejected
    authPassed = false;
    const unauthRes = responseRecorder();
    statusRoute.handler({}, unauthRes);
    assert.equal(unauthRes.statusCode, 401);

    // Test 2: Authenticated status query
    authPassed = true;
    tokenCoordinator.quarantineToken('bad-token', 'Manual Quarantine');
    const authRes = responseRecorder();
    statusRoute.handler({}, authRes);
    assert.equal(authRes.statusCode, 200);
    assert.equal(authRes.body.success, true);
    assert.equal(authRes.body.quarantinedCount, 1);

    // Test 3: Release quarantine
    const hash = tokenCoordinator.hashToken('bad-token');
    const releaseRes = responseRecorder();
    releaseRoute.handler({ body: { tokenHash: hash } }, releaseRes);
    assert.equal(releaseRes.statusCode, 200);
    assert.equal(releaseRes.body.success, true);
    assert.equal(releaseRes.body.released, true);
    assert.equal(tokenCoordinator.isQuarantined(hash), false);

    // Test 4: Clear profile cache
    tokenCoordinator.cacheTokenProfile('profile-token', { name: 'User' }, 5000);
    assert.ok(tokenCoordinator.getCachedTokenProfile('profile-token'));

    const clearRes = responseRecorder();
    clearRoute.handler({ body: {} }, clearRes);
    assert.equal(clearRes.statusCode, 200);
    assert.equal(clearRes.body.cleared, true);
    assert.equal(tokenCoordinator.getCachedTokenProfile('profile-token'), null);
});

test('DELETE /api/quest-scheduled/:id rejects invalid MongoDB ObjectId with 400 Bad Request', async () => {
    const { app, routes } = createMockApp();

    registerAdminRoutes({
        app,
        express,
        sessionManager: {},
        voiceWorker: {},
        commands: {},
        client: {},
        checkAuth: () => true,
        disabledCommands: new Set(),
        commandAuditLog: [],
        toggleCooldowns: new Map(),
        startRotateTimer: () => {},
        ROTATE_MESSAGES_MAX: 10
    });

    const deleteRoute = routes.find(r => r.method === 'DELETE' && r.path === '/api/quest-scheduled/:id');
    assert.ok(deleteRoute, 'DELETE /api/quest-scheduled/:id must be registered');

    // Passing invalid non-hex / non-24-character ObjectId should return 400
    const invalidRes = responseRecorder();
    await deleteRoute.handler({ params: { id: 'invalid-id' } }, invalidRes);
    assert.equal(invalidRes.statusCode, 400);
    assert.equal(invalidRes.body.success, false);
    assert.match(invalidRes.body.error, /Invalid scheduled runner ID/);
});

