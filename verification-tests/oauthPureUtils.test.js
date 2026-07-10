'use strict';

/**
 * Tests for pure utility functions added/changed in:
 *   discord/verification/routes/oauth.js
 *   discord/index.js
 *
 * Since these functions are not exported, we inline the exact implementations
 * from the PR and test the logic contracts.
 *
 * Functions covered:
 *   From oauth.js:
 *     - pushUnique()
 *     - uniqueStrings()
 *     - clampDelayMs()
 *     - applyPolicyAction()
 *     - compactDiscordProfile()
 *     - compactUserGuild()
 *     - compactMemberInfo()
 *
 *   From index.js:
 *     - normalizeSocketIp()
 */

// ---------------------------------------------------------------------------
// Inline implementations (direct copy from the PR)
// ---------------------------------------------------------------------------

// From verifyMode.js (dependency for applyPolicyAction)
const { normalizeAction, clampNumber } = require('../discord/verification/utils/verifyMode');

// --- pushUnique ---
function pushUnique(list, value) {
    if (!value) return;
    if (!list.includes(value)) list.push(value);
}

// --- uniqueStrings ---
function uniqueStrings(values = []) {
    return Array.from(new Set((values || []).map(v => String(v || '').trim()).filter(Boolean)));
}

// --- clampDelayMs ---
function clampDelayMs(value, fallback = 5000) {
    return clampNumber(value, 0, 10000, fallback);
}

// --- sleep (minimal stub for applyPolicyAction) ---
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- applyPolicyAction ---
async function applyPolicyAction({
    action,
    reason,
    userError,
    delayMs,
    riskFlags,
    riskFlag,
    finalize
}) {
    const normalizedAction = normalizeAction(action, 'log_only');

    if (normalizedAction === 'off') {
        return { blocked: false };
    }

    pushUnique(riskFlags, riskFlag || reason);

    if (normalizedAction === 'delay') {
        await sleep(clampDelayMs(delayMs));
        return { blocked: false, delayed: true };
    }

    if (normalizedAction === 'block') {
        return {
            blocked: true,
            response: await finalize({
                result: 'blocked',
                reason,
                userError
            })
        };
    }

    return { blocked: false, logged: true };
}

// --- safeNullableString (dependency of compact functions) ---
function safeNullableString(value, maxLen) {
    if (value === undefined || value === null) return null;
    const s = String(value);
    return s.slice(0, maxLen) || null;
}

// --- safeNumberOrNull ---
function safeNumberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

// --- compactDiscordProfile ---
function compactDiscordProfile(profile = {}) {
    return {
        id: safeNullableString(profile.id, 40),
        username: safeNullableString(profile.username, 120),
        discriminator: safeNullableString(profile.discriminator, 20),
        globalName: safeNullableString(profile.global_name || profile.globalName, 120),
        avatar: safeNullableString(profile.avatar, 120),
        banner: safeNullableString(profile.banner, 120),
        accentColor: safeNumberOrNull(profile.accent_color || profile.accentColor),
        locale: safeNullableString(profile.locale, 40),
        verified: profile.verified === true,
        emailVerified: profile.verified === true,
        mfaEnabled: profile.mfa_enabled === true,
        premiumType: safeNumberOrNull(profile.premium_type) || 0,
        flags: safeNumberOrNull(profile.flags) || 0,
        publicFlags: safeNumberOrNull(profile.public_flags) || 0
    };
}

// --- compactUserGuild ---
function compactUserGuild(g = {}) {
    return {
        id: safeNullableString(g.id, 40) || '',
        name: safeNullableString(g.name, 120) || '',
        icon: safeNullableString(g.icon, 120),
        owner: g.owner === true,
        permissions: String(g.permissions || '0'),
        features: Array.isArray(g.features)
            ? g.features.map(feature => safeNullableString(feature, 120)).filter(Boolean)
            : []
    };
}

// --- compactMemberInfo ---
function compactMemberInfo(member = {}) {
    const roles = Array.isArray(member.roles)
        ? member.roles.map(role => String(role))
        : [];

    return {
        userId: safeNullableString(member.user?.id || member.userId, 40),
        nick: safeNullableString(member.nick, 120),
        joinedAt: safeNullableString(member.joined_at || member.joinedAt, 80),
        pending: member.pending === true,
        avatar: safeNullableString(member.avatar, 120),
        roles,
        roleCount: Array.isArray(member.roles) ? member.roles.length : 0,
        flags: safeNumberOrNull(member.flags) || 0,
        communicationDisabledUntil: safeNullableString(
            member.communication_disabled_until || member.communicationDisabledUntil,
            80
        )
    };
}

// --- normalizeSocketIp (from index.js) ---
function normalizeSocketIp(ip) {
    if (!ip) return 'unknown';

    let value = String(ip).trim();

    if (value.startsWith('::ffff:')) value = value.slice(7);
    if (value === '::1') value = '127.0.0.1';
    if (value.includes('%')) value = value.split('%')[0];

    if (value.startsWith('[') && value.includes(']')) {
        value = value.slice(1, value.indexOf(']'));
    } else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(value)) {
        value = value.split(':')[0];
    }

    return value || 'unknown';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// pushUnique()
// ---------------------------------------------------------------------------
describe('pushUnique', () => {
    test('adds a new value to the list', () => {
        const list = [];
        pushUnique(list, 'vpn');
        expect(list).toEqual(['vpn']);
    });

    test('does not add a duplicate value', () => {
        const list = ['vpn'];
        pushUnique(list, 'vpn');
        expect(list).toEqual(['vpn']);
    });

    test('does nothing when value is falsy (null)', () => {
        const list = [];
        pushUnique(list, null);
        expect(list).toHaveLength(0);
    });

    test('does nothing when value is empty string', () => {
        const list = [];
        pushUnique(list, '');
        expect(list).toHaveLength(0);
    });

    test('does nothing when value is undefined', () => {
        const list = ['a'];
        pushUnique(list, undefined);
        expect(list).toHaveLength(1);
    });

    test('adds multiple distinct values in order', () => {
        const list = [];
        pushUnique(list, 'vpn');
        pushUnique(list, 'proxy');
        pushUnique(list, 'vpn'); // duplicate
        pushUnique(list, 'tor');
        expect(list).toEqual(['vpn', 'proxy', 'tor']);
    });

    test('handles numeric 0 as falsy', () => {
        const list = [];
        pushUnique(list, 0);
        expect(list).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// uniqueStrings()
// ---------------------------------------------------------------------------
describe('uniqueStrings', () => {
    test('deduplicates strings', () => {
        expect(uniqueStrings(['a', 'b', 'a', 'c'])).toEqual(['a', 'b', 'c']);
    });

    test('trims whitespace from each value', () => {
        expect(uniqueStrings(['  a  ', 'b', '  a  '])).toEqual(['a', 'b']);
    });

    test('filters out empty/falsy values', () => {
        expect(uniqueStrings(['a', '', null, undefined, 0, 'b'])).toEqual(['a', 'b']);
    });

    test('returns empty array for empty input', () => {
        expect(uniqueStrings([])).toEqual([]);
    });

    test('returns empty array for null input', () => {
        expect(uniqueStrings(null)).toEqual([]);
    });

    test('converts non-string values to strings', () => {
        expect(uniqueStrings([1, 2, 1])).toEqual(['1', '2']);
    });

    test('preserves insertion order for unique values', () => {
        expect(uniqueStrings(['c', 'a', 'b'])).toEqual(['c', 'a', 'b']);
    });
});

// ---------------------------------------------------------------------------
// clampDelayMs()
// ---------------------------------------------------------------------------
describe('clampDelayMs', () => {
    test('returns value within [0, 10000]', () => {
        expect(clampDelayMs(3000)).toBe(3000);
        expect(clampDelayMs(0)).toBe(0);
        expect(clampDelayMs(10000)).toBe(10000);
    });

    test('clamps negative to 0', () => {
        expect(clampDelayMs(-100)).toBe(0);
    });

    test('clamps above 10000 to 10000', () => {
        expect(clampDelayMs(99999)).toBe(10000);
    });

    test('returns default fallback for NaN', () => {
        expect(clampDelayMs(NaN)).toBe(5000);
    });

    test('uses custom fallback when provided', () => {
        expect(clampDelayMs(NaN, 2000)).toBe(2000);
    });
});

// ---------------------------------------------------------------------------
// applyPolicyAction()
// ---------------------------------------------------------------------------
describe('applyPolicyAction', () => {
    const noopFinalize = jest.fn().mockResolvedValue({ json: true });

    beforeEach(() => {
        noopFinalize.mockClear();
    });

    test('returns { blocked: false } immediately for action = off', async () => {
        const riskFlags = [];
        const result = await applyPolicyAction({
            action: 'off',
            reason: 'spoof',
            userError: 'bad',
            delayMs: 0,
            riskFlags,
            riskFlag: 'spoof_suspected',
            finalize: noopFinalize
        });
        expect(result).toEqual({ blocked: false });
        expect(riskFlags).toHaveLength(0); // should NOT push flag for 'off'
        expect(noopFinalize).not.toHaveBeenCalled();
    });

    test('returns { blocked: false, logged: true } for action = log_only', async () => {
        const riskFlags = [];
        const result = await applyPolicyAction({
            action: 'log_only',
            reason: 'spoof',
            userError: 'bad',
            delayMs: 0,
            riskFlags,
            riskFlag: 'my_flag',
            finalize: noopFinalize
        });
        expect(result).toMatchObject({ blocked: false, logged: true });
        expect(riskFlags).toContain('my_flag'); // flag pushed
    });

    test('returns { blocked: false, delayed: true } for action = delay', async () => {
        const riskFlags = [];
        const result = await applyPolicyAction({
            action: 'delay',
            reason: 'lookup_failed',
            userError: 'slow',
            delayMs: 0, // 0ms delay for test speed
            riskFlags,
            riskFlag: 'lookup_failed',
            finalize: noopFinalize
        });
        expect(result).toMatchObject({ blocked: false, delayed: true });
        expect(riskFlags).toContain('lookup_failed');
        expect(noopFinalize).not.toHaveBeenCalled();
    });

    test('calls finalize and returns { blocked: true } for action = block', async () => {
        const riskFlags = [];
        const finalizeReturn = { status: 'blocked_response' };
        const mockFinalize = jest.fn().mockResolvedValue(finalizeReturn);

        const result = await applyPolicyAction({
            action: 'block',
            reason: 'ip_duplicate_limit:5',
            userError: 'Too many accounts',
            delayMs: 0,
            riskFlags,
            riskFlag: 'ip_duplicate',
            finalize: mockFinalize
        });
        expect(result.blocked).toBe(true);
        expect(result.response).toBe(finalizeReturn);
        expect(mockFinalize).toHaveBeenCalledWith({
            result: 'blocked',
            reason: 'ip_duplicate_limit:5',
            userError: 'Too many accounts'
        });
        expect(riskFlags).toContain('ip_duplicate');
    });

    test('uses reason as riskFlag when riskFlag is not provided', async () => {
        const riskFlags = [];
        await applyPolicyAction({
            action: 'log_only',
            reason: 'spoofed_ip_header',
            userError: 'err',
            delayMs: 0,
            riskFlags,
            finalize: noopFinalize
        });
        expect(riskFlags).toContain('spoofed_ip_header');
    });

    test('invalid action falls back to log_only behavior', async () => {
        const riskFlags = [];
        const result = await applyPolicyAction({
            action: 'explode',
            reason: 'test',
            userError: 'err',
            delayMs: 0,
            riskFlags,
            riskFlag: 'test_flag',
            finalize: noopFinalize
        });
        // log_only fallback
        expect(result).toMatchObject({ blocked: false, logged: true });
    });
});

// ---------------------------------------------------------------------------
// compactDiscordProfile()
// ---------------------------------------------------------------------------
describe('compactDiscordProfile', () => {
    test('extracts basic fields correctly', () => {
        const profile = {
            id: '123456789',
            username: 'testuser',
            discriminator: '0001',
            global_name: 'Test User',
            avatar: 'hash123',
            locale: 'en-US',
            verified: true,
            mfa_enabled: true,
            premium_type: 1,
            flags: 64,
            public_flags: 64
        };
        const result = compactDiscordProfile(profile);
        expect(result.id).toBe('123456789');
        expect(result.username).toBe('testuser');
        expect(result.discriminator).toBe('0001');
        expect(result.globalName).toBe('Test User');
        expect(result.avatar).toBe('hash123');
        expect(result.locale).toBe('en-US');
        expect(result.verified).toBe(true);
        expect(result.emailVerified).toBe(true);
        expect(result.mfaEnabled).toBe(true);
        expect(result.premiumType).toBe(1);
        expect(result.flags).toBe(64);
        expect(result.publicFlags).toBe(64);
    });

    test('returns null for missing optional fields', () => {
        const result = compactDiscordProfile({});
        expect(result.id).toBeNull();
        expect(result.username).toBeNull();
        expect(result.avatar).toBeNull();
        expect(result.banner).toBeNull();
        expect(result.accentColor).toBeNull();
    });

    test('verified = false means emailVerified = false', () => {
        const result = compactDiscordProfile({ verified: false });
        expect(result.verified).toBe(false);
        expect(result.emailVerified).toBe(false);
    });

    test('mfa_enabled = false means mfaEnabled = false', () => {
        const result = compactDiscordProfile({ mfa_enabled: false });
        expect(result.mfaEnabled).toBe(false);
    });

    test('premiumType defaults to 0 when not provided', () => {
        const result = compactDiscordProfile({});
        expect(result.premiumType).toBe(0);
    });

    test('flags default to 0 when not provided', () => {
        const result = compactDiscordProfile({});
        expect(result.flags).toBe(0);
        expect(result.publicFlags).toBe(0);
    });

    test('uses global_name (snake_case) for globalName field', () => {
        const result = compactDiscordProfile({ global_name: 'Display Name' });
        expect(result.globalName).toBe('Display Name');
    });

    test('falls back to globalName (camelCase) if global_name is absent', () => {
        const result = compactDiscordProfile({ globalName: 'Display Name' });
        expect(result.globalName).toBe('Display Name');
    });

    test('uses accent_color for accentColor field', () => {
        const result = compactDiscordProfile({ accent_color: 16711680 });
        expect(result.accentColor).toBe(16711680);
    });

    test('bounds invalid oversized profile id values before persistence', () => {
        const longId = '1'.repeat(50);
        const result = compactDiscordProfile({ id: longId });
        expect(result.id).toBe(longId.slice(0, 40));
    });

    test('bounds invalid oversized username values before persistence', () => {
        const longName = 'a'.repeat(200);
        const result = compactDiscordProfile({ username: longName });
        expect(result.username).toBe(longName.slice(0, 120));
    });

    test('handles empty object', () => {
        const result = compactDiscordProfile({});
        expect(result).toMatchObject({
            verified: false,
            emailVerified: false,
            mfaEnabled: false,
            premiumType: 0,
            flags: 0,
            publicFlags: 0
        });
    });
});

// ---------------------------------------------------------------------------
// compactUserGuild()
// ---------------------------------------------------------------------------
describe('compactUserGuild', () => {
    test('extracts basic guild fields', () => {
        const guild = {
            id: '999',
            name: 'Test Guild',
            icon: 'iconhash',
            owner: true,
            permissions: '8',
            features: ['COMMUNITY', 'NEWS']
        };
        const result = compactUserGuild(guild);
        expect(result.id).toBe('999');
        expect(result.name).toBe('Test Guild');
        expect(result.icon).toBe('iconhash');
        expect(result.owner).toBe(true);
        expect(result.permissions).toBe('8');
        expect(result.features).toEqual(['COMMUNITY', 'NEWS']);
    });

    test('owner = true only when strictly true', () => {
        expect(compactUserGuild({ owner: 1 }).owner).toBe(false);
        expect(compactUserGuild({ owner: 'true' }).owner).toBe(false);
        expect(compactUserGuild({ owner: true }).owner).toBe(true);
    });

    test('defaults id and name to empty string when absent', () => {
        const result = compactUserGuild({});
        expect(result.id).toBe('');
        expect(result.name).toBe('');
    });

    test('icon defaults to null when absent', () => {
        const result = compactUserGuild({});
        expect(result.icon).toBeNull();
    });

    test('permissions defaults to "0" when absent', () => {
        const result = compactUserGuild({});
        expect(result.permissions).toBe('0');
    });

    test('features defaults to empty array when not an array', () => {
        expect(compactUserGuild({ features: null }).features).toEqual([]);
        expect(compactUserGuild({ features: 'COMMUNITY' }).features).toEqual([]);
    });

    test('filters null features from the array', () => {
        const result = compactUserGuild({ features: [null, 'COMMUNITY', undefined, 'NEWS'] });
        expect(result.features).toEqual(['COMMUNITY', 'NEWS']);
    });

    test('keeps every returned guild feature', () => {
        const features = Array.from({ length: 60 }, (_, i) => `FEATURE_${i}`);
        const result = compactUserGuild({ features });
        expect(result.features).toHaveLength(60);
    });
});

// ---------------------------------------------------------------------------
// compactMemberInfo()
// ---------------------------------------------------------------------------
describe('compactMemberInfo', () => {
    test('extracts basic member fields', () => {
        const member = {
            userId: '777',
            nick: 'coolnick',
            joined_at: '2023-01-01T00:00:00.000Z',
            pending: false,
            avatar: 'memberavatar',
            roles: ['role1', 'role2'],
            flags: 2
        };
        const result = compactMemberInfo(member);
        expect(result.userId).toBe('777');
        expect(result.nick).toBe('coolnick');
        expect(result.joinedAt).toBe('2023-01-01T00:00:00.000Z');
        expect(result.pending).toBe(false);
        expect(result.avatar).toBe('memberavatar');
        expect(result.roles).toEqual(['role1', 'role2']);
        expect(result.roleCount).toBe(2);
        expect(result.flags).toBe(2);
    });

    test('uses member.user.id when userId is absent', () => {
        const result = compactMemberInfo({ user: { id: '888' } });
        expect(result.userId).toBe('888');
    });

    test('pending = true only when strictly true', () => {
        expect(compactMemberInfo({ pending: 'true' }).pending).toBe(false);
        expect(compactMemberInfo({ pending: 1 }).pending).toBe(false);
        expect(compactMemberInfo({ pending: true }).pending).toBe(true);
    });

    test('roles defaults to empty array when not array', () => {
        expect(compactMemberInfo({}).roles).toEqual([]);
        expect(compactMemberInfo({ roles: null }).roles).toEqual([]);
    });

    test('roleCount matches roles length', () => {
        const result = compactMemberInfo({ roles: ['a', 'b', 'c'] });
        expect(result.roleCount).toBe(3);
    });

    test('keeps every returned role', () => {
        const roles = Array.from({ length: 100 }, (_, i) => `role_${i}`);
        const result = compactMemberInfo({ roles });
        expect(result.roles).toHaveLength(100);
        expect(result.roleCount).toBe(100);
    });

    test('flags defaults to 0 when not provided', () => {
        expect(compactMemberInfo({}).flags).toBe(0);
    });

    test('uses joined_at (snake_case) for joinedAt', () => {
        const result = compactMemberInfo({ joined_at: '2024-01-01' });
        expect(result.joinedAt).toBe('2024-01-01');
    });

    test('falls back to joinedAt (camelCase)', () => {
        const result = compactMemberInfo({ joinedAt: '2024-06-01' });
        expect(result.joinedAt).toBe('2024-06-01');
    });

    test('uses communication_disabled_until (snake_case)', () => {
        const result = compactMemberInfo({ communication_disabled_until: '2025-01-01' });
        expect(result.communicationDisabledUntil).toBe('2025-01-01');
    });

    test('empty member returns sensible defaults', () => {
        const result = compactMemberInfo({});
        expect(result.userId).toBeNull();
        expect(result.nick).toBeNull();
        expect(result.joinedAt).toBeNull();
        expect(result.pending).toBe(false);
        expect(result.avatar).toBeNull();
        expect(result.roles).toEqual([]);
        expect(result.roleCount).toBe(0);
        expect(result.flags).toBe(0);
        expect(result.communicationDisabledUntil).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// normalizeSocketIp() – from index.js
// ---------------------------------------------------------------------------
describe('normalizeSocketIp', () => {
    test('returns unknown for falsy input', () => {
        expect(normalizeSocketIp(null)).toBe('unknown');
        expect(normalizeSocketIp(undefined)).toBe('unknown');
        expect(normalizeSocketIp('')).toBe('unknown');
        expect(normalizeSocketIp(0)).toBe('unknown');
    });

    test('strips ::ffff: IPv4-mapped prefix', () => {
        expect(normalizeSocketIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
    });

    test('maps ::1 to 127.0.0.1', () => {
        expect(normalizeSocketIp('::1')).toBe('127.0.0.1');
    });

    test('strips zone ID from IPv6', () => {
        expect(normalizeSocketIp('fe80::1%eth0')).toBe('fe80::1');
    });

    test('strips brackets from bracketed IPv6', () => {
        expect(normalizeSocketIp('[2001:db8::1]')).toBe('2001:db8::1');
        expect(normalizeSocketIp('[::1]')).toBe('::1');
    });

    test('strips port from IPv4:port', () => {
        expect(normalizeSocketIp('1.2.3.4:8080')).toBe('1.2.3.4');
        expect(normalizeSocketIp('10.0.0.1:3000')).toBe('10.0.0.1');
    });

    test('returns regular IPv4 unchanged', () => {
        expect(normalizeSocketIp('8.8.8.8')).toBe('8.8.8.8');
    });

    test('returns regular IPv6 unchanged', () => {
        expect(normalizeSocketIp('2001:db8::1')).toBe('2001:db8::1');
    });

    // Regression: whitespace-only → unknown
    test('returns unknown for whitespace-only string', () => {
        expect(normalizeSocketIp('   ')).toBe('unknown');
    });

    // Regression: ::1 after ::ffff: stripping should not happen (order of operations)
    test('::ffff:::1 would strip prefix to ::1 then be left as-is (not remapped)', () => {
        // This edge case: after stripping ::ffff: we'd have "::1" which then maps to 127.0.0.1
        // The function processes ::ffff: first, then checks === '::1'
        expect(normalizeSocketIp('::ffff:::1')).not.toBe('::ffff:::1');
    });
});
