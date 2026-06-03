'use strict';

/*
 * Tests for dashboard-public/routes/adminSessionCompat.js
 *
 * The module exports an Express router with a single middleware that:
 * 1. Normalizes adminUser.userId <-> adminUser.id
 * 2. Syncs adminGuilds between session root and adminUser
 */

const adminSessionCompatRouter = require('../dashboard-public/routes/adminSessionCompat');

/**
 * Simulate running Express middleware for a given req object.
 * Returns a promise that resolves when next() is called.
 */
function runMiddleware(router, req) {
    return new Promise((resolve, reject) => {
        const res = {};
        const next = (err) => {
            if (err) reject(err);
            else resolve(req);
        };
        // Express router.handle requires a request with method and path
        req.method = req.method || 'GET';
        req.url = req.url || '/';
        router.handle(req, res, next);
    });
}

describe('adminSessionCompat middleware - normalizeAdminUserId', () => {
    test('syncs id → userId when userId is missing', async () => {
        const req = {
            session: {
                adminUser: { id: 'user123' }
            }
        };
        await runMiddleware(adminSessionCompatRouter, req);
        expect(req.session.adminUser.userId).toBe('user123');
    });

    test('syncs userId → id when id is missing', async () => {
        const req = {
            session: {
                adminUser: { userId: 'user456' }
            }
        };
        await runMiddleware(adminSessionCompatRouter, req);
        expect(req.session.adminUser.id).toBe('user456');
    });

    test('does not overwrite existing id when userId already set', async () => {
        const req = {
            session: {
                adminUser: { id: 'original', userId: 'keepthis' }
            }
        };
        await runMiddleware(adminSessionCompatRouter, req);
        // userId was already set, id was already set - no changes needed
        expect(req.session.adminUser.id).toBe('original');
        expect(req.session.adminUser.userId).toBe('keepthis');
    });

    test('does nothing when session has no adminUser', async () => {
        const req = { session: {} };
        await runMiddleware(adminSessionCompatRouter, req);
        expect(req.session.adminUser).toBeUndefined();
    });

    test('does nothing when session is null-ish', async () => {
        const req = {};
        await runMiddleware(adminSessionCompatRouter, req);
        // Should not throw
        expect(req.session).toBeUndefined();
    });
});

describe('adminSessionCompat middleware - normalizeAdminGuilds', () => {
    test('copies session.adminGuilds → adminUser.adminGuilds when adminUser.adminGuilds missing', async () => {
        const guilds = [{ id: 'g1' }, { id: 'g2' }];
        const req = {
            session: {
                adminUser: { id: 'u1' },
                adminGuilds: guilds
            }
        };
        await runMiddleware(adminSessionCompatRouter, req);
        expect(req.session.adminUser.adminGuilds).toEqual(guilds);
    });

    test('copies adminUser.adminGuilds → session.adminGuilds when session.adminGuilds missing', async () => {
        const guilds = [{ id: 'g1' }];
        const req = {
            session: {
                adminUser: { id: 'u1', adminGuilds: guilds }
            }
        };
        await runMiddleware(adminSessionCompatRouter, req);
        expect(req.session.adminGuilds).toEqual(guilds);
    });

    test('both already set: no mutation of either', async () => {
        const sessionGuilds = [{ id: 'sg1' }];
        const userGuilds = [{ id: 'ug1' }];
        const req = {
            session: {
                adminUser: { id: 'u1', adminGuilds: userGuilds },
                adminGuilds: sessionGuilds
            }
        };
        await runMiddleware(adminSessionCompatRouter, req);
        // Both existed - no cross-copy
        expect(req.session.adminGuilds).toEqual(sessionGuilds);
        expect(req.session.adminUser.adminGuilds).toEqual(userGuilds);
    });

    test('sets session.adminGuilds to [] when neither source has guilds', async () => {
        const req = {
            session: {
                adminUser: { id: 'u1' }
            }
        };
        await runMiddleware(adminSessionCompatRouter, req);
        expect(Array.isArray(req.session.adminGuilds)).toBe(true);
        expect(req.session.adminGuilds).toHaveLength(0);
    });

    test('sets adminUser.adminGuilds to [] when session.adminGuilds is empty and adminUser has none', async () => {
        const req = {
            session: {
                adminUser: { id: 'u1' }
            }
        };
        await runMiddleware(adminSessionCompatRouter, req);
        expect(Array.isArray(req.session.adminUser.adminGuilds)).toBe(true);
    });

    test('handles non-array session.adminGuilds gracefully (treats as missing)', async () => {
        const req = {
            session: {
                adminUser: { id: 'u1', adminGuilds: [{ id: 'g1' }] },
                adminGuilds: 'not-an-array'
            }
        };
        await runMiddleware(adminSessionCompatRouter, req);
        // non-array is treated as null → copy from adminUser
        expect(Array.isArray(req.session.adminGuilds)).toBe(true);
    });

    test('calls next() without error', async () => {
        const req = { session: { adminUser: { id: 'u1' } } };
        // runMiddleware resolves → next() was called without error
        await expect(runMiddleware(adminSessionCompatRouter, req)).resolves.toBeDefined();
    });

    test('works correctly when no session at all', async () => {
        const req = {};
        await expect(runMiddleware(adminSessionCompatRouter, req)).resolves.toBeDefined();
    });
});