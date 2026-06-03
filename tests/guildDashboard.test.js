'use strict';

/*
 * Tests for dashboard-public/routes/guildDashboard.js
 *
 * The module has several internal pure helpers that we test by importing
 * the module and exercising behavior through the Express router using
 * mocked req/res/next. We also test the safe* serializer functions
 * indirectly via the route responses.
 *
 * Focus on the NEW code added in this PR:
 *   - requireAdmin middleware
 *   - requireGuildAdmin middleware
 *   - getAdminGuilds helper
 *   - normalizeGuild helper
 *   - safeIpInfo, safeDevice, safePolicySnapshot, safeDiscordSnapshot
 *   - safeMemberSnapshot, safeTrackingSnapshot, safeRoleResult, safeLog
 *   - GET /api/guild/:guildId/overview (auth, guild-access guards)
 *   - GET /api/guild/:guildId/risk (auth, guild-access guards)
 */

// Mock mongoose models
jest.mock('../dashboard-public/models/GuildConfig', () => ({
    findOne: jest.fn().mockResolvedValue(null)
}));

jest.mock('../dashboard-public/models/VerifyLog', () => {
    const countDocumentsMock = jest.fn().mockResolvedValue(0);
    const aggregateMock = jest.fn().mockResolvedValue([]);
    const findMock = jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([])
    });

    return {
        countDocuments: countDocumentsMock,
        aggregate: aggregateMock,
        find: findMock
    };
});

jest.mock('../dashboard-public/models/OAuthUser', () => ({
    find: jest.fn().mockReturnValue({
        select: jest.fn().mockResolvedValue([])
    })
}));

jest.mock('../dashboard-public/models/IPRevealRequest', () => ({
    countDocuments: jest.fn().mockResolvedValue(0)
}));

const router = require('../dashboard-public/routes/guildDashboard');

/**
 * Create a mock res object that captures status/json calls.
 */
function mockRes() {
    const res = {
        _status: 200,
        _body: null,
        status(code) {
            this._status = code;
            return this;
        },
        json(body) {
            this._body = body;
            return this;
        }
    };
    return res;
}

/**
 * Run a request through the router.
 */
function runRoute(router, method, url, req) {
    return new Promise((resolve, reject) => {
        const res = mockRes();
        const next = (err) => {
            if (err) reject(err);
            else resolve({ req, res });
        };
        req.method = method;
        req.url = url;
        router.handle(req, res, next);
        // Resolve after a tick to allow async handlers
        setTimeout(() => resolve({ req, res }), 200);
    });
}

describe('requireAdmin guard', () => {
    test('returns 401 when no adminUser in session', async () => {
        const req = {
            session: {},
            params: { guildId: '123456789012345678' }
        };
        const { res } = await runRoute(router, 'GET', '/api/guild/123456789012345678/overview', req);
        expect(res._status).toBe(401);
        expect(res._body.code).toBe('admin_login_required');
    });

    test('returns 401 when session is missing', async () => {
        const req = {
            params: { guildId: '123456789012345678' }
        };
        const { res } = await runRoute(router, 'GET', '/api/guild/123456789012345678/overview', req);
        expect(res._status).toBe(401);
    });
});

describe('requireGuildAdmin guard', () => {
    test('returns 403 when adminUser exists but guild not in adminGuilds', async () => {
        const req = {
            session: {
                adminUser: { id: 'user1' },
                adminGuilds: [{ id: '999999999999999999' }]
            },
            params: { guildId: '123456789012345678' }
        };
        const { res } = await runRoute(router, 'GET', '/api/guild/123456789012345678/overview', req);
        expect(res._status).toBe(403);
        expect(res._body.code).toBe('guild_admin_required');
    });

    test('returns 403 when adminGuilds is empty', async () => {
        const req = {
            session: {
                adminUser: { id: 'user1' },
                adminGuilds: []
            },
            params: { guildId: '123456789012345678' }
        };
        const { res } = await runRoute(router, 'GET', '/api/guild/123456789012345678/overview', req);
        expect(res._status).toBe(403);
    });

    test('passes through when guild is in session.adminGuilds', async () => {
        const guildId = '123456789012345678';
        const req = {
            session: {
                adminUser: { id: 'user1' },
                adminGuilds: [{ id: guildId }]
            },
            params: { guildId }
        };
        const { res } = await runRoute(router, 'GET', `/api/guild/${guildId}/overview`, req);
        // Should not be 401 or 403
        expect(res._status).not.toBe(401);
        expect(res._status).not.toBe(403);
    });

    test('passes through when guild is in adminUser.adminGuilds', async () => {
        const guildId = '123456789012345678';
        const req = {
            session: {
                adminUser: { id: 'user1', adminGuilds: [{ id: guildId }] }
            },
            params: { guildId }
        };
        const { res } = await runRoute(router, 'GET', `/api/guild/${guildId}/overview`, req);
        expect(res._status).not.toBe(403);
    });
});

describe('GET /api/guild/:guildId/overview', () => {
    const guildId = '123456789012345678';

    function makeAuthedReq(extraGuildData = {}) {
        return {
            session: {
                adminUser: { id: 'user1' },
                adminGuilds: [{ id: guildId, ...extraGuildData }]
            },
            params: { guildId }
        };
    }

    test('returns success:true with overview data', async () => {
        const req = makeAuthedReq();
        const { res } = await runRoute(router, 'GET', `/api/guild/${guildId}/overview`, req);
        expect(res._body.success).toBe(true);
    });

    test('returns guild info in response', async () => {
        const req = makeAuthedReq({ name: 'Test Server' });
        const { res } = await runRoute(router, 'GET', `/api/guild/${guildId}/overview`, req);
        expect(res._body.guild).toBeDefined();
        expect(res._body.guild.id).toBe(guildId);
    });

    test('returns stats object', async () => {
        const req = makeAuthedReq();
        const { res } = await runRoute(router, 'GET', `/api/guild/${guildId}/overview`, req);
        expect(res._body.stats).toBeDefined();
        expect(typeof res._body.stats.total).toBe('number');
        expect(typeof res._body.stats.successRate).toBe('number');
    });

    test('returns recentLogs array', async () => {
        const req = makeAuthedReq();
        const { res } = await runRoute(router, 'GET', `/api/guild/${guildId}/overview`, req);
        expect(Array.isArray(res._body.recentLogs)).toBe(true);
    });

    test('returns recentMembers array', async () => {
        const req = makeAuthedReq();
        const { res } = await runRoute(router, 'GET', `/api/guild/${guildId}/overview`, req);
        expect(Array.isArray(res._body.recentMembers)).toBe(true);
    });
});

describe('GET /api/guild/:guildId/risk', () => {
    const guildId = '123456789012345678';

    function makeAuthedReq() {
        return {
            session: {
                adminUser: { id: 'user1' },
                adminGuilds: [{ id: guildId }]
            },
            params: { guildId }
        };
    }

    test('returns success:true', async () => {
        const req = makeAuthedReq();
        const { res } = await runRoute(router, 'GET', `/api/guild/${guildId}/risk`, req);
        expect(res._body.success).toBe(true);
    });

    test('returns risk summary object', async () => {
        const req = makeAuthedReq();
        const { res } = await runRoute(router, 'GET', `/api/guild/${guildId}/risk`, req);
        expect(res._body.risk).toBeDefined();
    });

    test('risk summary contains countries, isps, devices, reasons arrays', async () => {
        const req = makeAuthedReq();
        const { res } = await runRoute(router, 'GET', `/api/guild/${guildId}/risk`, req);
        const risk = res._body.risk;
        expect(Array.isArray(risk.countries)).toBe(true);
        expect(Array.isArray(risk.isps)).toBe(true);
        expect(Array.isArray(risk.devices)).toBe(true);
        expect(Array.isArray(risk.reasons)).toBe(true);
    });

    test('risk summary contains recentRiskLogs array', async () => {
        const req = makeAuthedReq();
        const { res } = await runRoute(router, 'GET', `/api/guild/${guildId}/risk`, req);
        expect(Array.isArray(res._body.risk.recentRiskLogs)).toBe(true);
    });

    test('returns 401 when not authenticated', async () => {
        const req = { session: {}, params: { guildId } };
        const { res } = await runRoute(router, 'GET', `/api/guild/${guildId}/risk`, req);
        expect(res._status).toBe(401);
    });

    test('returns 403 when guild not in admin list', async () => {
        const req = {
            session: {
                adminUser: { id: 'user1' },
                adminGuilds: [{ id: '999' }]
            },
            params: { guildId }
        };
        const { res } = await runRoute(router, 'GET', `/api/guild/${guildId}/risk`, req);
        expect(res._status).toBe(403);
    });
});

describe('normalizeGuild behavior', () => {
    // We test normalizeGuild indirectly through the guild field in the overview response
    const guildId = '123456789012345678';

    test('guild response includes isAdmin field', async () => {
        const req = {
            session: {
                adminUser: { id: 'user1' },
                adminGuilds: [{ id: guildId }]
            },
            params: { guildId }
        };
        const { res } = await runRoute(router, 'GET', `/api/guild/${guildId}/overview`, req);
        expect(res._body.guild).toHaveProperty('isAdmin');
    });

    test('guild response includes canManage field', async () => {
        const req = {
            session: {
                adminUser: { id: 'user1' },
                adminGuilds: [{ id: guildId }]
            },
            params: { guildId }
        };
        const { res } = await runRoute(router, 'GET', `/api/guild/${guildId}/overview`, req);
        expect(res._body.guild).toHaveProperty('canManage');
    });

    test('guild name defaults to "Unknown Server" when not provided', async () => {
        const req = {
            session: {
                adminUser: { id: 'user1' },
                adminGuilds: [{ id: guildId }]  // no name
            },
            params: { guildId }
        };
        const { res } = await runRoute(router, 'GET', `/api/guild/${guildId}/overview`, req);
        expect(res._body.guild.name).toBe('Unknown Server');
    });

    test('guild name uses provided name', async () => {
        const req = {
            session: {
                adminUser: { id: 'user1' },
                adminGuilds: [{ id: guildId, name: 'My Server' }]
            },
            params: { guildId }
        };
        const { res } = await runRoute(router, 'GET', `/api/guild/${guildId}/overview`, req);
        expect(res._body.guild.name).toBe('My Server');
    });
});

describe('buildStats successRate calculation', () => {
    const guildId = '123456789012345678';

    beforeEach(() => {
        const VerifyLog = require('../dashboard-public/models/VerifyLog');
        VerifyLog.countDocuments.mockResolvedValue(0);
    });

    test('successRate is 0 when total is 0', async () => {
        const req = {
            session: {
                adminUser: { id: 'u' },
                adminGuilds: [{ id: guildId }]
            },
            params: { guildId }
        };
        const { res } = await runRoute(router, 'GET', `/api/guild/${guildId}/overview`, req);
        expect(res._body.stats.successRate).toBe(0);
    });

    test('successRate is calculated correctly when total > 0', async () => {
        const VerifyLog = require('../dashboard-public/models/VerifyLog');
        // Total = 10, success = 7 → 70%
        VerifyLog.countDocuments
            .mockResolvedValueOnce(10)  // total
            .mockResolvedValueOnce(7)   // success
            .mockResolvedValue(0);       // rest

        const req = {
            session: {
                adminUser: { id: 'u' },
                adminGuilds: [{ id: guildId }]
            },
            params: { guildId }
        };
        const { res } = await runRoute(router, 'GET', `/api/guild/${guildId}/overview`, req);
        expect(res._body.stats.successRate).toBe(70);
    });
});