const nodeTest = require('node:test');
const describe = globalThis.describe || nodeTest.describe;
const test = globalThis.test || globalThis.it || nodeTest.it || nodeTest.test;
const expect = globalThis.expect || require('expect').expect || require('expect');

const {
    getAccountCreatedAt,
    getAccountAgeDays,
    decodeUserBadgeFlags,
    getAvatarUrl,
    getBannerUrl,
    displayTag,
    normalizeConnections,
    computeGuildSummary,
    collectDiscordData,
    USER_BADGE_FLAGS
} = require('../discord/verification/services/collectors/discordDataCollector');
const discord = require('../discord/verification/utils/discordAPI');
const oauthTokenManager = require('../discord/tokens/oauthTokenManager');

describe('discordDataCollector pure helpers', () => {
    test('getAccountCreatedAt: extracts epoch from snowflake ID', () => {
        // Discord Epoch: (175928847299117063n >> 22n) + 1420070400000n
        const timestamp = getAccountCreatedAt('175928847299117063');
        expect(Number.isFinite(timestamp)).toBe(true);
        expect(timestamp).toBeGreaterThan(1420070400000);

        // Invalid IDs
        expect(getAccountCreatedAt('not-a-number')).toBeNull();
        expect(getAccountCreatedAt(null)).toBeNull();
    });

    test('getAccountAgeDays: computes days since creation', () => {
        const days = getAccountAgeDays('175928847299117063');
        expect(Number.isFinite(days)).toBe(true);
        expect(days).toBeGreaterThan(0);

        expect(getAccountAgeDays('invalid')).toBe(0);
    });

    test('decodeUserBadgeFlags: decodes public_flags bitfield', () => {
        // STAFF (1) + HYPESQUAD (4) = 5
        const badges = decodeUserBadgeFlags({ public_flags: 5 });
        expect(badges).toContain('STAFF');
        expect(badges).toContain('HYPESQUAD');
        expect(badges).not.toContain('PARTNER');

        // Fallback to flags
        const fallbackBadges = decodeUserBadgeFlags({ flags: 2 });
        expect(fallbackBadges).toEqual(['PARTNER']);

        // Empty profile
        expect(decodeUserBadgeFlags({})).toEqual([]);
    });

    test('getAvatarUrl: resolves CDN URLs and fallbacks', () => {
        // Animated avatar
        expect(getAvatarUrl({ id: '123', avatar: 'a_animatedhash' })).toBe(
            'https://cdn.discordapp.com/avatars/123/a_animatedhash.gif?size=256'
        );

        // Static avatar
        expect(getAvatarUrl({ id: '123', avatar: 'statichash' })).toBe(
            'https://cdn.discordapp.com/avatars/123/statichash.png?size=256'
        );

        // No avatar with legacy discriminator #0004 -> 4 % 5 = 4
        expect(getAvatarUrl({ id: '123', discriminator: '0004' })).toBe(
            'https://cdn.discordapp.com/embed/avatars/4.png'
        );

        // No avatar with Pomelo ('0') discriminator -> uses snowflake mod 6
        const pomeloAvatar = getAvatarUrl({ id: '175928847299117063', discriminator: '0' });
        expect(pomeloAvatar).toMatch(/^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/);

        // Invalid snowflake fallback
        expect(getAvatarUrl({ id: 'invalid', discriminator: '0' })).toBe(
            'https://cdn.discordapp.com/embed/avatars/0.png'
        );
    });

    test('getBannerUrl: resolves animated and static banners', () => {
        expect(getBannerUrl({})).toBeNull();
        expect(getBannerUrl({ banner: null })).toBeNull();

        expect(getBannerUrl({ id: '123', banner: 'a_animated' })).toBe(
            'https://cdn.discordapp.com/banners/123/a_animated.gif?size=512'
        );
        expect(getBannerUrl({ id: '123', banner: 'staticbanner' })).toBe(
            'https://cdn.discordapp.com/banners/123/staticbanner.png?size=512'
        );
    });

    test('displayTag: formats username and discriminator', () => {
        // Legacy tag
        expect(displayTag({ username: 'bob', discriminator: '1234' })).toBe('bob#1234');

        // Pomelo tag
        expect(displayTag({ username: 'bob', discriminator: '0' })).toBe('@bob');
        expect(displayTag({ username: 'alice' })).toBe('@alice');
    });

    test('normalizeConnections: standardizes external account connections storing only type and verified', () => {
        expect(normalizeConnections(null)).toEqual([]);
        expect(normalizeConnections('not-array')).toEqual([]);

        const raw = [
            'github',
            {
                id: 'conn1',
                type: 'spotify',
                name: 'octocat',
                verified: true
            },
            {
                // missing type
                name: 'invalid'
            }
        ];

        const normalized = normalizeConnections(raw);
        expect(normalized.length).toBe(2);
        expect(normalized[0]).toEqual({ type: 'github', verified: false });
        expect(normalized[1]).toEqual({ type: 'spotify', verified: true });
    });

    test('computeGuildSummary: parses administrative privileges', () => {
        // Failed / null input fallback
        const failedSummary = computeGuildSummary(null, true, 'timeout');
        expect(failedSummary.status).toBe('failed');
        expect(failedSummary.failureReason).toBe('timeout');

        const guilds = [
            { id: 'g1', owner: true, permissions: '0' },
            { id: 'g2', owner: false, permissions: '8' }, // Administrator (0x8)
            { id: 'g3', owner: false, permissions: 8 },   // Numeric administrator
            { id: 'g4', owner: false, permissions: '0' }
        ];

        const summary = computeGuildSummary(guilds, false, null);
        expect(summary.totalCount).toBe(4);
        expect(summary.ownedCount).toBe(1);
        expect(summary.adminCount).toBe(3); // g1 (owner has admin permission) + g2 + g3
        expect(summary.status).toBe('success');
    });
});

describe('collectDiscordData integration', () => {
    test('fetches profile, connections, and guilds with token and normalizes payload', async () => {
        const origExchange = oauthTokenManager.exchangeAuthorizationCode;
        const origGetProfile = discord.getUserProfile;
        const origGetConnections = discord.getUserConnections;
        const origGetGuilds = discord.getUserGuilds;

        oauthTokenManager.exchangeAuthorizationCode = async () => ({
            access_token: 'fake_access_token',
            refresh_token: 'fake_refresh_token',
            token_type: 'Bearer',
            expires_in: 604800,
            scope: 'identify email guilds connections'
        });

        discord.getUserProfile = async () => ({
            id: '175928847299117063',
            username: 'testuser',
            discriminator: '0',
            avatar: 'testavatar',
            email: 'test@example.com',
            verified: true,
            mfa_enabled: true,
            public_flags: 1
        });

        discord.getUserConnections = async () => [
            { id: 'c1', type: 'spotify', name: 'spotify_user', verified: true }
        ];

        discord.getUserGuilds = async () => [
            { id: 'g1', name: 'Guild 1', owner: true, permissions: '8' }
        ];

        try {
            const data = await collectDiscordData({ code: 'auth_code_123', redirectUri: 'https://example.com/callback' });

            expect(data.accessToken).toBe('fake_access_token');
            expect(data.profile.id).toBe('175928847299117063');
            expect(data.profile.displayTag).toBe('@testuser');
            expect(data.profile.email).toBe('test@example.com');
            expect(data.profile.emailVerified).toBe(true);
            expect(data.profile.mfaEnabled).toBe(true);
            expect(data.profile.badgeFlags).toContain('STAFF');
            expect(data.connections.length).toBe(1);
            expect(data.connections[0]).toEqual({ type: 'spotify', verified: true });
            expect(data.guildSummary.totalCount).toBe(1);
            expect(data.guildSummary.ownedCount).toBe(1);
            expect(data.guildSummary.adminCount).toBe(1);
            expect(data.fetchMetadata.connectionsFetchFailed).toBe(false);
            expect(data.fetchMetadata.guildsFetchFailed).toBe(false);
        } finally {
            oauthTokenManager.exchangeAuthorizationCode = origExchange;
            discord.getUserProfile = origGetProfile;
            discord.getUserConnections = origGetConnections;
            discord.getUserGuilds = origGetGuilds;
        }
    });

    test('handles fallback when connections or guilds fetch fails gracefully', async () => {
        const origExchange = oauthTokenManager.exchangeAuthorizationCode;
        const origGetProfile = discord.getUserProfile;
        const origGetConnections = discord.getUserConnections;
        const origGetGuilds = discord.getUserGuilds;

        oauthTokenManager.exchangeAuthorizationCode = async () => ({
            access_token: 'fake_access_token'
        });

        discord.getUserProfile = async () => ({
            id: '123456789',
            username: 'fallbackuser',
            discriminator: '1234'
        });

        discord.getUserConnections = async () => {
            throw new Error('Rate limited');
        };

        discord.getUserGuilds = async () => {
            throw new Error('Unauthorized scope');
        };

        try {
            const data = await collectDiscordData({
                code: 'auth_code_123',
                redirectUri: 'https://example.com/callback',
                previousConnections: [{ type: 'twitch', verified: true }],
                previousSummary: { totalCount: 5, ownedCount: 1, adminCount: 2 }
            });

            expect(data.profile.displayTag).toBe('fallbackuser#1234');
            expect(data.connections).toEqual([{ type: 'twitch', verified: true }]);
            expect(data.guildSummary.totalCount).toBe(5);
            expect(data.guildSummary.status).toBe('failed');
            expect(data.fetchMetadata.connectionsFetchFailed).toBe(true);
            expect(data.fetchMetadata.guildsFetchFailed).toBe(true);
        } finally {
            oauthTokenManager.exchangeAuthorizationCode = origExchange;
            discord.getUserProfile = origGetProfile;
            discord.getUserConnections = origGetConnections;
            discord.getUserGuilds = origGetGuilds;
        }
    });

    test('handles null rawProfile when getUserProfile returns null', async () => {
        const origExchange = oauthTokenManager.exchangeAuthorizationCode;
        const origGetProfile = discord.getUserProfile;
        const origGetConnections = discord.getUserConnections;
        const origGetGuilds = discord.getUserGuilds;

        oauthTokenManager.exchangeAuthorizationCode = async () => ({
            access_token: 'fake_access_token'
        });

        discord.getUserProfile = async () => null;
        discord.getUserConnections = async () => [];
        discord.getUserGuilds = async () => [];

        try {
            const data = await collectDiscordData({
                code: 'auth_code_null_profile',
                redirectUri: 'https://example.com/callback'
            });

            expect(data.profile.id).toBe('');
            expect(data.profile.username).toBe('');
            expect(data.profile.rawProfile).toEqual({});
        } finally {
            oauthTokenManager.exchangeAuthorizationCode = origExchange;
            discord.getUserProfile = origGetProfile;
            discord.getUserConnections = origGetConnections;
            discord.getUserGuilds = origGetGuilds;
        }
    });
});

