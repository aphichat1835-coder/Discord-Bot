const {
    normalizeSensitiveAccess,
    canViewSensitiveData,
    buildSensitiveAccessPatch,
    redactSensitiveDiscordSnapshot,
    redactSensitiveIpInfo
} = require('../utils/sensitiveAccess');

describe('sensitive data access helpers', () => {
    test('defaults to disabled access', () => {
        const access = normalizeSensitiveAccess({});

        expect(access.enabled).toBe(false);
        expect(access.scope).toEqual(['rawIp', 'email', 'connections', 'guilds']);
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

        const revoke = buildSensitiveAccessPatch({
            enabled: false,
            actor: 'owner',
            ownerNote: 'stop'
        });

        expect(revoke['security.sensitiveDataAccess.enabled']).toBe(false);
        expect(revoke['security.sensitiveDataAccess.revokedBy']).toBe('owner');
        expect(revoke['security.sensitiveDataAccess.ownerNote']).toBe('stop');
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
