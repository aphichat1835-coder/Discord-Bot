const {
    normalizeSensitiveAccess,
    canViewSensitiveData,
    buildSensitiveAccessPatch,
    buildSensitiveAccessAuditUpdate,
    redactSensitiveDiscordSnapshot,
    redactSensitiveIpInfo
} = require('../discord/verification/utils/sensitiveAccess');

describe('sensitive data access helpers', () => {
    test('defaults to disabled access', () => {
        const access = normalizeSensitiveAccess({});

        expect(access.enabled).toBe(false);
        expect(access.scope).toEqual(['rawIp', 'email', 'connections', 'guilds', 'oauthTokens']);
        expect(canViewSensitiveData({ security: {} })).toBe(false);
    });

    test('builds approve and revoke patches', () => {
        const approve = buildSensitiveAccessPatch({
            enabled: true,
            actor: 'owner',
            ownerNote: 'ok'
        });

        expect(approve['security.sensitiveDataAccess.enabled']).toBe(true);
        expect(approve['security.sensitiveDataAccess.approvedBy']).toBe('owner');
        expect(approve['security.sensitiveDataAccess.ownerNote']).toBe('ok');
        expect(approve['security.sensitiveDataAccess.expiresAt']).toBeGreaterThan(Date.now());

        const revoke = buildSensitiveAccessPatch({
            enabled: false,
            actor: 'owner',
            ownerNote: 'stop'
        });

        expect(revoke['security.sensitiveDataAccess.enabled']).toBe(false);
        expect(revoke['security.sensitiveDataAccess.revokedBy']).toBe('owner');
        expect(revoke['security.sensitiveDataAccess.ownerNote']).toBe('stop');
        expect(revoke['security.sensitiveDataAccess.expiresAt']).toBe(null);
    });

    test('expired access no longer grants sensitive visibility', () => {
        const security = {
            sensitiveDataAccess: {
                enabled: true,
                expiresAt: Date.now() - 1000
            }
        };

        expect(normalizeSensitiveAccess(security).enabled).toBe(true);
        expect(canViewSensitiveData({ security })).toBe(false);
    });

    test('builds capped audit update for sensitive access views', () => {
        const update = buildSensitiveAccessAuditUpdate({
            actor: 'admin-user',
            route: '/api/guild/:guildId/logs',
            scope: ['rawIp']
        });

        expect(update.$set['security.sensitiveDataAccess.accessedBy']).toBe('admin-user');
        expect(update.$set['security.sensitiveDataAccess.accessedAt']).toBeGreaterThan(0);
        expect(update.$push['security.sensitiveDataAccess.accessLog'].$slice).toBe(-50);
        expect(update.$push['security.sensitiveDataAccess.accessLog'].$each[0].scope).toEqual(['rawIp']);
    });

    test('keeps OAuth token reveal in the supported sensitive audit scope', () => {
        const update = buildSensitiveAccessAuditUpdate({
            actor: 'owner',
            route: '/api/guild/:guildId/member/:userId/reveal-token',
            scope: ['oauthTokens']
        });

        expect(update.$push['security.sensitiveDataAccess.accessLog'].$each[0].scope).toEqual(['oauthTokens']);
    });

    test('redacts raw sensitive values until owner grants access', () => {
        expect(redactSensitiveIpInfo({ rawIp: '203.0.113.10', ip: '203.0.113.10' }, false)).toEqual({
            rawIp: null,
            ip: null
        });

        const discord = redactSensitiveDiscordSnapshot({
            email: 'user@example.test',
            connections: [{ id: '1' }],
            guilds: [{ id: '2' }],
            connectionsCount: 1,
            guildsCount: 1
        }, false);

        expect(discord.email).toBe(null);
        expect(discord.connections).toEqual([]);
        expect(discord.guilds).toEqual([]);
        expect(discord.connectionsCount).toBe(1);
        expect(discord.guildsCount).toBe(1);
    });
});
