'use strict';

/**
 * Tests for pure utility functions added/changed in:
 *   discord/verification/routes/oauth.js
 *   discord/index.js
 *
 * OAuth helpers are imported from the production route's test surface so this
 * suite fails when the runtime implementation regresses.
 *
 * Functions covered:
 *   From oauth.js:
 *     - pushUnique()
 *     - uniqueStrings()
 *     - compactDiscordProfile()
 *     - compactUserGuild()
 *     - compactMemberInfo()
 *
 *   From index.js:
 *     - normalizeSocketIp()
 */

// ---------------------------------------------------------------------------
// Production OAuth helpers
// ---------------------------------------------------------------------------

const oauthRoute = require('../discord/verification/routes/oauth');
const {
    pushUnique,
    uniqueStrings,
    safeIpHashStrict,
    compactDiscordProfile,
    compactUserGuild,
    compactMemberInfo
} = oauthRoute._test;

describe('strict Mongo query identifiers', () => {
    test('accepts only a scalar SHA-256 hex IP hash', () => {
        const hash = 'a'.repeat(64);
        expect(safeIpHashStrict(hash.toUpperCase())).toBe(hash);
        expect(() => safeIpHashStrict({ $ne: null })).toThrow('invalid ip_hash');
        expect(() => safeIpHashStrict('not-a-hash')).toThrow('invalid ip_hash');
    });
});

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

describe('OAuth persistence quality helpers', () => {
    test('failed post-role refresh remains failed when stale member data exists', () => {
        const metadata = {
            memberFetchAttempted: true,
            memberFetchFailed: true,
            memberFailureReason: 'discord_bot_member_refresh_failed'
        };
        expect(oauthRoute._test.memberFetchQualityStatus(metadata, { roles: ['old-role'] }))
            .toBe('failed');
        expect(oauthRoute._test.preserveFailedMemberAttempt(
            { member: { status: 'success', fetchedAt: 200 } },
            { member: { fetchedAt: 100 } },
            metadata,
            300
        ).member).toMatchObject({
            status: 'failed',
            fetchedAt: 100,
            attemptedAt: 300,
            failureReason: 'discord_bot_member_refresh_failed'
        });
    });

    test('device extraction fallback is explicitly marked failed', () => {
        const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
        const device = oauthRoute._test.safeExtractDevice({ headers: {}, body: {} }, () => {
            throw new Error('device parser failed');
        });
        expect(device).toMatchObject({
            extractionStatus: 'failed',
            extractionFailureReason: 'browser_payload_extraction_failed'
        });
        errorLog.mockRestore();
    });

    test('connection integration token-shaped fields are sanitized', () => {
        const [connection] = oauthRoute._test.normalizeConnections([{
            type: 'service',
            id: 'account',
            integrations: [{ name: 'linked', oauth_token: 'secret-value' }]
        }]);
        expect(connection.integrations[0].oauth_token).toBe('[stored-encrypted-separately]');
        expect(JSON.stringify(connection.integrations)).not.toContain('secret-value');
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

    test('premiumType remains unknown when Discord does not provide it', () => {
        const result = compactDiscordProfile({});
        expect(result.premiumType).toBeNull();
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
            emailVerified: null,
            mfaEnabled: null,
            premiumType: null,
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
    test('maps ::ffff:::1 to IPv4 loopback after stripping the prefix', () => {
        // This edge case: after stripping ::ffff: we'd have "::1" which then maps to 127.0.0.1
        // The function processes ::ffff: first, then checks === '::1'
        expect(normalizeSocketIp('::ffff:::1')).toBe('127.0.0.1');
    });

});

describe('decomposed OAuth callback helpers', () => {
    const {
        getCdnExtension,
        getMemberAvatarUrl,
        normalizeCountryList,
        buildPolicySnapshot,
        makeRuleViolation,
        strongestRuleViolation,
        executeRuleViolation,
        makeRequestId,
        publicDebugCode,
        jsonFail,
        getConfiguredRoleId,
        getConfiguredRoleName,
        getGuildName,
        getLatestPanelRevision,
        getStatePanelRevision,
        isPanelRevisionValid,
        collectPolicyFindings,
        resolveFinalPersistenceStatus,
        buildProfileQuality,
        buildConnectionsQuality,
        buildGuildsQuality,
        resolveMemberQualityStatus,
        buildMemberQuality,
        buildDeviceQuality,
        buildNetworkQuality,
        buildVerificationDataQuality,
        checkCallbackPreconditions,
        checkAccountEligibilityRequirements,
        checkNetworkSecurityRules,
        checkIpDuplicateAndHistoryRules,
        collectSecurityPolicyViolations,
        enforceSelectedPolicyViolation,
        buildVerificationOutcomeResponse
    } = oauthRoute._test;

    test('getCdnExtension identifies animated vs static hashes', () => {
        expect(getCdnExtension('a_1234567890')).toBe('gif');
        expect(getCdnExtension('1234567890')).toBe('png');
        expect(getCdnExtension('')).toBe('png');
        expect(getCdnExtension(null)).toBe('png');
    });

    test('getMemberAvatarUrl formats CDN url or returns null', () => {
        expect(getMemberAvatarUrl('u1', 'g1', 'avatar1')).toBe('https://cdn.discordapp.com/guilds/g1/users/u1/avatars/avatar1.png?size=128');
        expect(getMemberAvatarUrl('u1', 'g1', 'a_anim')).toBe('https://cdn.discordapp.com/guilds/g1/users/u1/avatars/a_anim.gif?size=128');
        expect(getMemberAvatarUrl(null, 'g1', 'avatar1')).toBeNull();
        expect(getMemberAvatarUrl('u1', null, 'avatar1')).toBeNull();
        expect(getMemberAvatarUrl('u1', 'g1', null)).toBeNull();
    });

    test('normalizeCountryList trims and uppercases country codes', () => {
        expect(normalizeCountryList([' th ', 'us', '', '   '])).toEqual(['TH', 'US']);
        expect(normalizeCountryList(null)).toEqual([]);
        expect(normalizeCountryList('TH')).toEqual([]);
    });

    test('buildPolicySnapshot normalizes security rules and account age', () => {
        const snapshot = buildPolicySnapshot({
            minAccountAgeDays: 14,
            requireEmail: true,
            requireConnections: true
        });
        expect(snapshot.minAccountAgeDays).toBe(14);
        expect(snapshot.requireEmail).toBe(true);
        expect(snapshot.requireConnections).toBe(true);
        expect(snapshot.securityRules).toBeDefined();
    });

    test('makeRuleViolation constructs violation if rule enabled', () => {
        const v = makeRuleViolation('vpn', { enabled: true, action: 'timeout', timeoutMinutes: 30 }, 'vpn_detected', 'VPN error');
        expect(v).toEqual({
            key: 'vpn',
            action: 'timeout',
            timeoutMinutes: 30,
            reason: 'vpn_detected',
            userError: 'VPN error'
        });
        expect(makeRuleViolation('vpn', { enabled: false }, 'reason')).toBeNull();
        expect(makeRuleViolation('vpn', null, 'reason')).toBeNull();
    });

    test('strongestRuleViolation orders actions by moderation priority', () => {
        const list = [
            { action: 'allow' },
            { action: 'timeout' },
            { action: 'ban' },
            { action: 'deny_role' }
        ];
        expect(strongestRuleViolation(list)?.action).toBe('ban');
        expect(strongestRuleViolation([])).toBeNull();
    });

    test('executeRuleViolation handles allow, deny_role, and absent member', async () => {
        expect(await executeRuleViolation({ violation: null })).toEqual({ blocked: false, action: 'allow' });
        expect(await executeRuleViolation({ violation: { action: 'allow' } })).toEqual({ blocked: false, action: 'allow' });
        expect(await executeRuleViolation({ violation: { action: 'deny_role' } })).toEqual({
            blocked: true,
            ok: true,
            action: 'deny_role',
            status: 'role_denied'
        });
        expect(await executeRuleViolation({ violation: { action: 'timeout' }, memberInfo: null })).toEqual({
            blocked: true,
            ok: true,
            action: 'deny_role',
            requestedAction: 'timeout',
            status: 'member_absent_role_denied'
        });
    });

    test('makeRequestId formats with prefix and random entropy', () => {
        const reqId = makeRequestId('verify');
        expect(reqId).toMatch(/^verify_[a-z0-9]+_[a-f0-9]+$/);
    });

    test('publicDebugCode sanitizes codes and limits length', () => {
        expect(publicDebugCode('test:detail:123')).toBe('test');
        expect(publicDebugCode('invalid!@#code')).toBe('invalid___code');
        expect(publicDebugCode('')).toBe('unknown_error');
    });

    test('jsonFail sends standard failure JSON payload', () => {
        let sentStatus = 0;
        let sentBody = null;
        const res = {
            status(s) { sentStatus = s; return this; },
            json(b) { sentBody = b; return this; }
        };
        jsonFail(res, 'User message', 'error_code:detail', 400, 'req-1');
        expect(sentStatus).toBe(400);
        expect(sentBody).toEqual({
            success: false,
            error: 'User message',
            code: 'error_code',
            debugCode: 'error_code',
            requestId: 'req-1'
        });
    });

    test('role and guild metadata getters extract configured values', () => {
        const guildConfig = {
            guildName: 'Guild Name',
            verification: {
                roleId: 'role-123',
                roleName: 'Verified Role',
                panelRevision: 'rev-42'
            }
        };
        expect(getConfiguredRoleId(guildConfig, 'fallback-role')).toBe('role-123');
        expect(getConfiguredRoleId({}, 'fallback-role')).toBe('fallback-role');
        expect(getConfiguredRoleName(guildConfig)).toBe('Verified Role');
        expect(getConfiguredRoleName({})).toBeNull();
        expect(getGuildName(guildConfig, 'g1')).toBe('Guild Name');
        expect(getGuildName(null, 'g1')).toBe('g1');
        expect(getLatestPanelRevision(guildConfig)).toBe('rev-42');
        expect(getLatestPanelRevision({})).toBeNull();
        expect(getStatePanelRevision({ panelRevision: 'rev-state' })).toBe('rev-state');
        expect(getStatePanelRevision({})).toBeNull();
    });

    test('isPanelRevisionValid validates against database revision', () => {
        expect(isPanelRevisionValid({}, {})).toEqual({
            ok: true,
            latestRevision: null,
            stateRevision: null,
            mode: 'compat-no-db-revision'
        });
        const cfgWithRev = { verification: { panelRevision: 'rev-1' } };
        expect(isPanelRevisionValid(cfgWithRev, {})).toEqual({
            ok: false,
            latestRevision: 'rev-1',
            stateRevision: null,
            mode: 'missing-state-revision'
        });
        expect(isPanelRevisionValid(cfgWithRev, { panelRevision: 'rev-2' })).toEqual({
            ok: false,
            latestRevision: 'rev-1',
            stateRevision: 'rev-2',
            mode: 'revision-mismatch'
        });
        expect(isPanelRevisionValid(cfgWithRev, { panelRevision: 'rev-1' })).toEqual({
            ok: true,
            latestRevision: 'rev-1',
            stateRevision: 'rev-1',
            mode: 'revision-match'
        });
    });

    test('collectPolicyFindings aggregates IP risk flags', () => {
        const ipInfo = {
            isVPN: true,
            isProxy: true,
            isTOR: true,
            hosting: true,
            spoofSuspected: true,
            lookupStatus: 'lookup_failed',
            findings: ['custom_flag']
        };
        const findings = collectPolicyFindings(ipInfo, ['initial_flag']);
        expect(findings).toContain('initial_flag');
        expect(findings).toContain('vpn');
        expect(findings).toContain('proxy');
        expect(findings).toContain('tor');
        expect(findings).toContain('hosting');
        expect(findings).toContain('spoof_suspected');
        expect(findings).toContain('lookup_failed');
        expect(findings).toContain('custom_flag');

        const ipInfo2 = { lookupStatus: 'ip_unknown' };
        expect(collectPolicyFindings(ipInfo2)).toContain('ip_unknown');
    });

    test('resolveFinalPersistenceStatus marks failure when oauth persistence is incomplete', () => {
        const ok = resolveFinalPersistenceStatus('success', 'verified', null, { saved: true });
        expect(ok.persistenceIncomplete).toBe(false);
        expect(ok.finalResult).toBe('success');

        const failed = resolveFinalPersistenceStatus('success', 'verified', null, { saved: false });
        expect(failed.persistenceIncomplete).toBe(true);
        expect(failed.finalResult).toBe('failed');
        expect(failed.finalReason).toBe('verification_persistence_failed');
    });

    test('buildVerificationDataQuality produces complete diagnostic reports for success and failure', () => {
        const quality = buildVerificationDataQuality({
            oauthPersistence: {
                snapshotWrites: {
                    profile: { complete: true, storedCount: 1, chunkCount: 0, version: 'v1' },
                    connections: { complete: true, storedCount: 2, chunkCount: 0, version: 'v1' },
                    guilds: { complete: true, storedCount: 3, chunkCount: 0, version: 'v1' },
                    member: { complete: true, storedCount: 1, roleStoredCount: 2, version: 'v1' }
                }
            },
            fetchMetadata: {
                memberFetchAttempted: true,
                memberFetchSource: 'discord_oauth'
            },
            connections: [{ id: 'c1' }, { id: 'c2' }],
            guilds: [{ id: 'g1' }, { id: 'g2' }, { id: 'g3' }],
            memberInfo: { id: 'm1' },
            device: { extractionStatus: 'success' },
            ipInfo: { lookupStatus: 'success', lookupAt: Date.now() }
        });
        expect(quality.version).toBe(2);
        expect(quality.profile.status).toBe('success');
        expect(quality.connections.status).toBe('success');
        expect(quality.guilds.status).toBe('success');
        expect(quality.member.status).toBe('success');
        expect(quality.device.status).toBe('success');
        expect(quality.network.status).toBe('success');

        const qualityFailed = buildVerificationDataQuality({
            oauthPersistence: {
                snapshotWrites: {
                    profile: { complete: false, failureReason: 'disk_full' },
                    connections: { complete: false, failureReason: 'conn_err' },
                    guilds: { complete: false, failureReason: 'guild_err' },
                    member: { complete: false, failureReason: 'mem_err' }
                }
            },
            fetchMetadata: {
                connectionsFetchFailed: true,
                connectionsFailureReason: 'http_500',
                guildsFetchFailed: true,
                guildsFailureReason: 'http_502',
                memberFetchFailed: true,
                memberFailureReason: 'http_404',
                memberFetchAttempted: true
            },
            connections: null,
            guilds: null,
            memberInfo: null,
            device: { extractionStatus: 'failed', extractionFailureReason: 'no_agent' },
            ipInfo: { lookupStatus: 'failed', lookupAt: null }
        });
        expect(qualityFailed.profile.status).toBe('failed');
        expect(qualityFailed.connections.status).toBe('failed');
        expect(qualityFailed.guilds.status).toBe('failed');
        expect(qualityFailed.member.status).toBe('failed');
        expect(qualityFailed.device.status).toBe('failed');
        expect(qualityFailed.network.status).toBe('failed');
    });

    test('checkCallbackPreconditions verifies user, roles, and enabled state', () => {
        expect(checkCallbackPreconditions({
            expectedUserId: 'user-1',
            profile: { id: 'user-2' }
        })?.reason).toBe('oauth_user_mismatch');

        expect(checkCallbackPreconditions({
            profile: { id: 'user-1' },
            guildConfig: null,
            configuredRoleId: null
        })?.reason).toBe('guild_config_missing_role');

        expect(checkCallbackPreconditions({
            profile: { id: 'user-1' },
            guildConfig: { verification: { roleId: 'role-1' } },
            configuredRoleId: 'role-1',
            stateObj: {},
            verificationConfig: { enabled: false }
        })?.reason).toBe('verification_disabled');

        expect(checkCallbackPreconditions({
            profile: { id: 'user-1' },
            guildConfig: { verification: { roleId: 'role-1' } },
            configuredRoleId: 'role-1',
            stateObj: {},
            stateRoleId: 'role-old',
            verificationConfig: { enabled: true }
        })?.reason).toBe('role_mismatch_latest_config');

        expect(checkCallbackPreconditions({
            profile: { id: 'user-1' },
            guildConfig: { verification: { roleId: 'role-1' } },
            configuredRoleId: 'role-1',
            stateObj: {},
            stateRoleId: 'role-1',
            verificationConfig: { enabled: true }
        })).toBeNull();
    });

    test('checkAccountEligibilityRequirements validates age, email, and connections', () => {
        const policy = {
            minAccountAgeDays: 7,
            requireEmail: true,
            requireConnections: true
        };
        expect(checkAccountEligibilityRequirements({
            accountAgeDays: 3,
            policySnapshot: policy,
            emailOk: true,
            connectionOk: true,
            connectionCount: 2
        })?.reason).toBe('new_account:3');

        expect(checkAccountEligibilityRequirements({
            accountAgeDays: 10,
            policySnapshot: policy,
            emailOk: false,
            connectionOk: true,
            connectionCount: 2
        })?.reason).toBe('email_requirement_failed');

        expect(checkAccountEligibilityRequirements({
            accountAgeDays: 10,
            policySnapshot: policy,
            emailOk: true,
            connectionOk: false,
            connectionCount: 0
        })?.reason).toBe('connection_requirement_failed:0');

        expect(checkAccountEligibilityRequirements({
            accountAgeDays: 10,
            policySnapshot: policy,
            emailOk: true,
            connectionOk: true,
            connectionCount: 2
        })).toBeNull();
    });

    test('checkNetworkSecurityRules reports vpn, proxy, tor, and hosting flags', () => {
        const recorded = [];
        const recordRule = (key, reason, userError) => recorded.push({ key, reason });
        checkNetworkSecurityRules({ isVPN: true, hosting: true, spoofSuspected: true }, recordRule);
        expect(recorded.map(r => r.key)).toEqual(['vpnProxyTor', 'hosting', 'spoofedHeader']);
    });

    test('checkIpDuplicateAndHistoryRules records limits and previous blocks', () => {
        const recorded = [];
        const recordRule = (key, reason) => recorded.push({ key, reason });
        checkIpDuplicateAndHistoryRules({
            existingIpLink: { lastResult: 'blocked' },
            trackedUsers: [{ userId: 'other-1' }, { userId: 'other-2' }, { userId: 'other-3' }, { userId: 'other-4' }],
            securityRules: { ipDuplicate: { threshold: 3 } },
            profile: { id: 'self' },
            recordRule
        });
        expect(recorded.map(r => r.key)).toContain('ipDuplicate');
        expect(recorded.map(r => r.key)).toContain('previouslyBlockedIp');
    });

    test('collectSecurityPolicyViolations collects violations from rules', async () => {
        const res = await collectSecurityPolicyViolations({
            ipInfo: { isVPN: true },
            existingIpLink: null,
            trackedUsers: [],
            securityRules: {
                vpnProxyTor: { enabled: true, action: 'deny_role', timeoutMinutes: 60 }
            },
            profile: { id: 'u1' },
            device: null,
            guildId: 'g1'
        });
        expect(res.policyFindings).toContain('network_vpn_proxy_tor');
        expect(res.policyViolations[0].action).toBe('deny_role');
    });

    test('enforceSelectedPolicyViolation blocks role assignment on violation', async () => {
        expect(await enforceSelectedPolicyViolation({ selectedViolation: null })).toBeNull();
        expect(await enforceSelectedPolicyViolation({ selectedViolation: { action: 'allow' } })).toBeNull();

        const outcome = await enforceSelectedPolicyViolation({
            selectedViolation: {
                key: 'vpn',
                action: 'deny_role',
                reason: 'vpn_detected',
                userError: 'VPN is blocked'
            },
            guildId: 'g1',
            profile: { id: 'u1' },
            memberInfo: null
        });
        expect(outcome.result).toBe('blocked');
        expect(outcome.reason).toBe('vpn_detected');
        expect(outcome.roleAssignResult.skipped).toBe(true);
    });

    test('buildVerificationOutcomeResponse builds standard success and failure responses', () => {
        const success = buildVerificationOutcomeResponse({
            finalResult: 'success',
            message: '',
            requestId: 'req-ok',
            persistenceIncomplete: true,
            roleName: 'Verified',
            dmSent: true,
            profile: { id: 'u1', username: 'user' }
        });
        expect(success.success).toBe(true);
        expect(success.message).toBe('ระบบเพิ่มยศให้เรียบร้อยแล้ว');
        expect(success.recoveryRequired).toBe(true);
        expect(success.roleName).toBe('Verified');
        expect(success.user.id).toBe('u1');

        const failure = buildVerificationOutcomeResponse({
            finalResult: 'failed',
            finalUserError: 'Something wrong',
            finalReason: 'bad_token',
            requestId: 'req-err',
            roleName: 'Verified',
            dmSent: false,
            profile: { id: 'u1', username: 'user' }
        });
        expect(failure.success).toBe(false);
        expect(failure.error).toBe('Something wrong');
        expect(failure.code).toBe('bad_token');
    });
});


