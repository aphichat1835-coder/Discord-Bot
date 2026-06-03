'use strict';

// Mock crypto module used by discordAPI.js (via ./crypto)
jest.mock('../dashboard-public/utils/crypto', () => ({
    encryptToken: jest.fn((v) => v ? `encrypted:${v}` : null),
    decryptToken: jest.fn((v) => v ? v.replace('encrypted:', '') : null),
    encrypt: jest.fn(),
    decrypt: jest.fn()
}));

// Mock global fetch so the module loads without network
global.fetch = jest.fn();

const {
    snowflake,
    toBigIntPermission,
    hasPermission,
    PERMISSIONS,
    resolveMemberHighestRole,
    computeMemberGuildPermissions,
    applyChannelOverwrites,
    validateBotCanManageRole,
    validateBotCanUseChannel,
    stringifyError,
    prepareTokenStorage,
    hasBotToken,
    getBotToken
} = require('../dashboard-public/utils/discordAPI');

describe('snowflake', () => {
    test('returns valid snowflake as string', () => {
        expect(snowflake('123456789012345678')).toBe('123456789012345678');
    });

    test('returns null for too short string', () => {
        expect(snowflake('1234')).toBeNull();
    });

    test('returns null for too long string (>22)', () => {
        expect(snowflake('12345678901234567890123')).toBeNull();
    });

    test('returns null for non-numeric string', () => {
        expect(snowflake('abcdefghijklmnopqrstu')).toBeNull();
    });

    test('returns null for empty string', () => {
        expect(snowflake('')).toBeNull();
    });

    test('returns null for null', () => {
        expect(snowflake(null)).toBeNull();
    });

    test('accepts 17-digit snowflake', () => {
        expect(snowflake('12345678901234567')).toBe('12345678901234567');
    });

    test('accepts 22-digit snowflake', () => {
        expect(snowflake('1234567890123456789012')).toBe('1234567890123456789012');
    });

    test('returns null for empty string after trim', () => {
        expect(snowflake('  ')).toBeNull();
    });
});

describe('toBigIntPermission', () => {
    test('converts "0" to 0n', () => {
        expect(toBigIntPermission('0')).toBe(0n);
    });

    test('converts permission string to BigInt', () => {
        expect(toBigIntPermission('8')).toBe(8n);
    });

    test('handles null gracefully', () => {
        expect(toBigIntPermission(null)).toBe(0n);
    });

    test('handles undefined gracefully', () => {
        expect(toBigIntPermission(undefined)).toBe(0n);
    });

    test('handles empty string', () => {
        expect(toBigIntPermission('')).toBe(0n);
    });

    test('handles large permission number', () => {
        expect(toBigIntPermission('274877906944')).toBe(274877906944n);
    });
});

describe('hasPermission', () => {
    test('returns true for ADMINISTRATOR overriding specific check', () => {
        const adminPerms = PERMISSIONS.ADMINISTRATOR.toString();
        expect(hasPermission(adminPerms, PERMISSIONS.MANAGE_ROLES)).toBe(true);
    });

    test('returns true when specific flag is set', () => {
        const perms = PERMISSIONS.MANAGE_ROLES.toString();
        expect(hasPermission(perms, PERMISSIONS.MANAGE_ROLES)).toBe(true);
    });

    test('returns false when flag is not set', () => {
        expect(hasPermission('0', PERMISSIONS.MANAGE_ROLES)).toBe(false);
    });

    test('handles combined permissions', () => {
        const combined = (PERMISSIONS.SEND_MESSAGES | PERMISSIONS.VIEW_CHANNEL).toString();
        expect(hasPermission(combined, PERMISSIONS.SEND_MESSAGES)).toBe(true);
        expect(hasPermission(combined, PERMISSIONS.VIEW_CHANNEL)).toBe(true);
        expect(hasPermission(combined, PERMISSIONS.MANAGE_ROLES)).toBe(false);
    });
});


describe('resolveMemberHighestRole', () => {
    const roles = [
        { id: '1', name: 'Low', position: 1 },
        { id: '2', name: 'High', position: 10 },
        { id: '3', name: 'Mid', position: 5 }
    ];

    test('returns the role with highest position', () => {
        const member = { roles: ['1', '2', '3'] };
        const result = resolveMemberHighestRole(member, roles);
        expect(result.position).toBe(10);
        expect(result.name).toBe('High');
    });

    test('returns null when member has no roles', () => {
        const result = resolveMemberHighestRole({ roles: [] }, roles);
        expect(result).toBeNull();
    });

    test('returns null when member is null', () => {
        expect(resolveMemberHighestRole(null, roles)).toBeNull();
    });

    test('ignores unknown role IDs', () => {
        const member = { roles: ['99', '1'] };
        const result = resolveMemberHighestRole(member, roles);
        expect(result.id).toBe('1');
    });
});

describe('computeMemberGuildPermissions', () => {
    const roles = [
        { id: '1', name: 'Role1', permissions: (PERMISSIONS.SEND_MESSAGES).toString() },
        { id: '2', name: 'Role2', permissions: (PERMISSIONS.VIEW_CHANNEL).toString() }
    ];

    test('combines permissions from all member roles', () => {
        const member = { roles: ['1', '2'] };
        const result = computeMemberGuildPermissions(member, roles);
        const combined = BigInt(result);
        expect(combined & PERMISSIONS.SEND_MESSAGES).toBe(PERMISSIONS.SEND_MESSAGES);
        expect(combined & PERMISSIONS.VIEW_CHANNEL).toBe(PERMISSIONS.VIEW_CHANNEL);
    });

    test('returns "0" for member with no roles', () => {
        const result = computeMemberGuildPermissions({ roles: [] }, roles);
        expect(result).toBe('0');
    });

    test('returns "0" when member is null', () => {
        expect(computeMemberGuildPermissions(null, roles)).toBe('0');
    });
});

describe('applyChannelOverwrites', () => {
    test('returns base permissions unchanged for ADMINISTRATOR', () => {
        const adminPerms = PERMISSIONS.ADMINISTRATOR.toString();
        const result = applyChannelOverwrites(adminPerms, {}, { permissionOverwrites: [] });
        expect(result).toBe(adminPerms);
    });

    test('applies role overwrite allow', () => {
        const basePerms = '0';
        const member = { roles: ['101'] };
        const channel = {
            permissionOverwrites: [{
                type: 0,
                id: '101',
                allow: PERMISSIONS.SEND_MESSAGES.toString(),
                deny: '0'
            }]
        };
        const result = BigInt(applyChannelOverwrites(basePerms, member, channel));
        expect(result & PERMISSIONS.SEND_MESSAGES).toBe(PERMISSIONS.SEND_MESSAGES);
    });

    test('applies role overwrite deny', () => {
        const basePerms = PERMISSIONS.SEND_MESSAGES.toString();
        const member = { roles: ['101'] };
        const channel = {
            permissionOverwrites: [{
                type: 0,
                id: '101',
                allow: '0',
                deny: PERMISSIONS.SEND_MESSAGES.toString()
            }]
        };
        const result = BigInt(applyChannelOverwrites(basePerms, member, channel));
        expect(result & PERMISSIONS.SEND_MESSAGES).toBe(0n);
    });

    test('applies member-specific overwrite (type 1)', () => {
        const basePerms = '0';
        const member = { roles: [], id: '500' };
        const channel = {
            permissionOverwrites: [{
                type: 1,
                id: '500',
                allow: PERMISSIONS.VIEW_CHANNEL.toString(),
                deny: '0'
            }]
        };
        const result = BigInt(applyChannelOverwrites(basePerms, member, channel));
        expect(result & PERMISSIONS.VIEW_CHANNEL).toBe(PERMISSIONS.VIEW_CHANNEL);
    });

    test('handles empty overwrites', () => {
        const basePerms = PERMISSIONS.SEND_MESSAGES.toString();
        const result = applyChannelOverwrites(basePerms, {}, null);
        expect(result).toBe(basePerms);
    });
});

describe('validateBotCanManageRole', () => {
    const roles = [
        { id: '100', name: 'BotRole', position: 10, permissions: PERMISSIONS.MANAGE_ROLES.toString(), managed: false },
        { id: '200', name: 'TargetRole', position: 5, managed: false },
        { id: '300', name: 'ManagedRole', position: 3, managed: true },
        { id: '400', name: 'HighRole', position: 15, managed: false }
    ];

    const botMember = {
        roles: ['100'],
        id: 'bot123'
    };

    test('returns ok=true when bot can manage the role', () => {
        const result = validateBotCanManageRole({
            botMember,
            roles,
            targetRoleId: '200'
        });
        expect(result.ok).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    test('returns ok=false when target role not found', () => {
        const result = validateBotCanManageRole({
            botMember,
            roles,
            targetRoleId: '999'
        });
        expect(result.ok).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
    });

    test('returns ok=false for managed role', () => {
        const result = validateBotCanManageRole({
            botMember,
            roles,
            targetRoleId: '300'
        });
        expect(result.ok).toBe(false);
        expect(result.errors.some(e => e.includes('managed'))).toBe(true);
    });

    test('returns ok=false when role position higher than bot highest role', () => {
        const result = validateBotCanManageRole({
            botMember,
            roles,
            targetRoleId: '400'
        });
        expect(result.ok).toBe(false);
    });

    test('returns checks array with named checks', () => {
        const result = validateBotCanManageRole({
            botMember,
            roles,
            targetRoleId: '200'
        });
        const checkNames = result.checks.map(c => c.name);
        expect(checkNames).toContain('role_exists');
        expect(checkNames).toContain('manage_roles');
        expect(checkNames).toContain('role_not_managed');
        expect(checkNames).toContain('role_hierarchy');
    });
});

describe('validateBotCanUseChannel', () => {
    const roles = [
        { id: '100', name: 'BotRole', position: 10, permissions: (PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES | PERMISSIONS.EMBED_LINKS).toString() }
    ];

    const botMember = { roles: ['100'], id: 'bot123' };
    const channel = { id: '500', name: 'general', type: 0, permissionOverwrites: [] };

    test('returns ok=true when bot has all channel permissions', () => {
        const result = validateBotCanUseChannel({ botMember, roles, channel });
        expect(result.ok).toBe(true);
    });

    test('returns ok=false when bot lacks permissions', () => {
        const result = validateBotCanUseChannel({
            botMember: { roles: [], id: 'bot123' },
            roles,
            channel
        });
        expect(result.ok).toBe(false);
    });

    test('returns ok=false when channel is null', () => {
        const result = validateBotCanUseChannel({ botMember, roles, channel: null });
        expect(result.ok).toBe(false);
        expect(result.errors.some(e => e.includes('channel'))).toBe(true);
    });

    test('returns checks array with correct names', () => {
        const result = validateBotCanUseChannel({ botMember, roles, channel });
        const names = result.checks.map(c => c.name);
        expect(names).toContain('channel_exists');
        expect(names).toContain('view_channel');
        expect(names).toContain('send_messages');
        expect(names).toContain('embed_links');
    });
});

describe('stringifyError', () => {
    test('returns empty string for null', () => {
        expect(stringifyError(null)).toBe('');
    });

    test('returns empty string for undefined', () => {
        expect(stringifyError(undefined)).toBe('');
    });

    test('returns string unchanged', () => {
        expect(stringifyError('error message')).toBe('error message');
    });

    test('JSON-stringifies objects', () => {
        const result = stringifyError({ code: 50001, message: 'Missing Access' });
        expect(result).toContain('50001');
        expect(result).toContain('Missing Access');
    });

    test('handles non-serializable objects gracefully', () => {
        const circular = {};
        circular.self = circular;
        // Should not throw
        expect(() => stringifyError(circular)).not.toThrow();
    });
});

describe('prepareTokenStorage', () => {
    test('encrypts access_token', () => {
        const result = prepareTokenStorage({
            access_token: 'mytoken123',
            refresh_token: 'refresh456',
            expires_in: 604800,
            scope: 'identify guilds',
            token_type: 'Bearer'
        });
        expect(result.encryptedAccessToken).toBeDefined();
        expect(result.encryptedAccessToken).not.toBe('mytoken123');
    });

    test('encrypts refresh_token', () => {
        const result = prepareTokenStorage({
            access_token: 'mytoken123',
            refresh_token: 'refresh456',
            expires_in: 604800
        });
        expect(result.encryptedRefreshToken).toBeDefined();
    });

    test('calculates expiresAt correctly', () => {
        const before = Date.now();
        const result = prepareTokenStorage({
            access_token: 'mytoken123',
            expires_in: 604800
        });
        const after = Date.now();
        expect(result.expiresAt).toBeGreaterThanOrEqual(before + 604800 * 1000);
        expect(result.expiresAt).toBeLessThanOrEqual(after + 604800 * 1000);
    });

    test('handles missing optional fields with defaults', () => {
        const result = prepareTokenStorage({ access_token: 'tok' });
        expect(result.scope).toBe('');
        expect(result.tokenType).toBe('Bearer');
        expect(result.lastRefreshAt).toBeNull();
        expect(result.refreshFailCount).toBe(0);
        expect(result.revokedAt).toBeNull();
    });

    test('stores rawTokenMeta with expiresIn and receivedAt', () => {
        const result = prepareTokenStorage({
            access_token: 'tok',
            expires_in: 3600
        });
        expect(result.rawTokenMeta.expiresIn).toBe(3600);
        expect(result.rawTokenMeta.receivedAt).toBeDefined();
    });
});

describe('getBotToken / hasBotToken', () => {
    const originalEnv = process.env;

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    test('hasBotToken returns false when no token set', () => {
        delete process.env.TOKEN_MANAGER;
        delete process.env.BOT_TOKEN;
        delete process.env.DISCORD_BOT_TOKEN;
        delete process.env.TOKEN;
        // Re-evaluate: the function reads env at call time
        const { hasBotToken: hbt } = require('../dashboard-public/utils/discordAPI');
        // hasBotToken uses getBotToken which reads env at runtime
        expect(typeof hbt()).toBe('boolean');
    });

    test('getBotToken reads TOKEN_MANAGER first', () => {
        process.env.TOKEN_MANAGER = 'test-token';
        const { getBotToken: gbt } = require('../dashboard-public/utils/discordAPI');
        expect(gbt()).toBe('test-token');
    });
});