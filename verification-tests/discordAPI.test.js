'use strict';

const discordAPI = require('../discord/verification/utils/discordAPI');

describe('Discord API memory guards', () => {
    test('exports compatible guild-member join names', () => {
        expect(discordAPI.addMemberToGuild).toEqual(expect.any(Function));
        expect(discordAPI.addGuildMember).toBe(discordAPI.addMemberToGuild);
    });

    test('classifies Discord invalid_grant errors without parsing raw logs', () => {
        const err = new discordAPI.DiscordApiError('exchangeCode', 400, {
            error: 'invalid_grant',
            error_description: 'Invalid code'
        });

        expect(err.status).toBe(400);
        expect(err.providerCode).toBe('invalid_grant');
        expect(discordAPI.isOAuthInvalidGrantError(err)).toBe(true);
        expect(discordAPI.isOAuthInvalidGrantError(new Error('network failed'))).toBe(false);
    });

    test('classifies optional fetch failures with redacted stable codes', () => {
        expect(discordAPI.optionalFetchFailureReason(
            new Error('Discord API response too large: 999 bytes')
        )).toBe('discord_response_too_large');
        expect(discordAPI.optionalFetchFailureReason(
            Object.assign(new Error('timeout'), { name: 'AbortError' })
        )).toBe('discord_request_timeout');
        const failed = discordAPI.optionalFetchFailure(503, 'discord_http_503');
        expect(failed).toHaveLength(0);
        expect(failed.fetchFailed).toBe(true);
        expect(failed.fetchStatus).toBe(503);
        expect(failed.fetchFailureReason).toBe('discord_http_503');
    });

    test('reports bounded request/response diagnostics', () => {
        const diag = discordAPI.getDiscordApiDiagnostics();

        expect(diag).toHaveProperty('total');
        expect(diag).toHaveProperty('inFlight');
        expect(diag).toHaveProperty('responseTooLarge');
        expect(diag).toHaveProperty('requestBodyTooLarge');
        expect(diag).toHaveProperty('responseMaxBytes');
        expect(diag).toHaveProperty('bodyMaxBytes');
        expect(diag).toHaveProperty('roleMax');
        expect(diag).toHaveProperty('channelMax');
        expect(diag).toHaveProperty('permissionOverwriteMax');
        expect(diag.responseMaxBytes).toBeGreaterThan(0);
        expect(diag.responseMaxBytes).toBe(12 * 1024 * 1024);
        expect(diag.bodyMaxBytes).toBeGreaterThan(0);
        expect(diag.roleMax).toBeGreaterThan(0);
        expect(diag.channelMax).toBeGreaterThan(0);
        expect(diag.permissionOverwriteMax).toBeGreaterThan(0);
    });

    test('rejects oversized request bodies before buffering a network request', async () => {
        const before = discordAPI.getDiscordApiDiagnostics().requestBodyTooLarge;
        const oversizedBody = 'x'.repeat(discordAPI.getDiscordApiDiagnostics().bodyMaxBytes + 1);

        await expect(discordAPI.apiFetch('/users/@me', {
            method: 'POST',
            body: oversizedBody
        })).rejects.toThrow(/request body too large/);

        const after = discordAPI.getDiscordApiDiagnostics().requestBodyTooLarge;
        expect(after).toBeGreaterThan(before);
    });

    test('caps dashboard role and channel normalization payloads', () => {
        const diag = discordAPI.getDiscordApiDiagnostics();
        const roles = Array.from({ length: diag.roleMax + 25 }, (_, idx) => ({
            id: String(10000000000000000n + BigInt(idx)),
            name: `Role ${idx}`,
            position: idx
        }));
        const channels = Array.from({ length: diag.channelMax + 25 }, (_, idx) => ({
            id: String(20000000000000000n + BigInt(idx)),
            name: `Channel ${idx}`,
            type: 0,
            position: idx,
            permission_overwrites: Array.from({ length: diag.permissionOverwriteMax + 10 }, (__, owIdx) => ({
                id: String(30000000000000000n + BigInt(owIdx)),
                type: 0,
                allow: '0',
                deny: '0'
            }))
        }));

        const sortedRoles = discordAPI.sortRolesForDashboard(roles);
        const sortedChannels = discordAPI.sortChannelsForDashboard(channels);

        expect(sortedRoles).toHaveLength(diag.roleMax);
        expect(sortedChannels).toHaveLength(diag.channelMax);
        expect(sortedChannels[0].permissionOverwrites).toHaveLength(diag.permissionOverwriteMax);
    });
});
