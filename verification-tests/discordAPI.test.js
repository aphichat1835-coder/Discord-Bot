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

    test('includes @everyone permissions that Discord omits from member.roles', () => {
        const permissions = discordAPI.computeMemberGuildPermissions({
            roles: ['bot-role']
        }, [
            { id: 'guild-id', name: '@everyone', permissions: '1024' },
            { id: 'bot-role', name: 'Bot', permissions: '2048' }
        ]);

        expect(BigInt(permissions) & 1024n).toBe(1024n);
        expect(BigInt(permissions) & 2048n).toBe(2048n);
    });

    test('combines role overwrites without depending on Discord array order', () => {
        const member = {
            user: { id: 'bot-user' },
            roles: ['allow-role', 'deny-role']
        };
        const allowOverwrite = { id: 'allow-role', type: 0, allow: '2048', deny: '0' };
        const denyOverwrite = { id: 'deny-role', type: 0, allow: '0', deny: '2048' };
        const channel = {
            guildId: 'guild-id',
            permissionOverwrites: [allowOverwrite, denyOverwrite]
        };
        const reversedChannel = {
            ...channel,
            permissionOverwrites: [denyOverwrite, allowOverwrite]
        };

        const first = discordAPI.applyChannelOverwrites('2048', member, channel);
        const reversed = discordAPI.applyChannelOverwrites('2048', member, reversedChannel);

        expect(BigInt(first) & 2048n).toBe(2048n);
        expect(reversed).toBe(first);
    });

    test('excludes forum containers that cannot receive a panel message directly', () => {
        const channels = discordAPI.sortChannelsForDashboard([
            { id: 'text', name: 'text', type: 0, position: 0 },
            { id: 'announcement', name: 'announcement', type: 5, position: 1 },
            { id: 'forum', name: 'forum', type: 15, position: 2 }
        ]);

        expect(channels.map(channel => channel.id)).toEqual(['text', 'announcement']);
    });

    test('reports implicit send and embed denial when the bot cannot view a channel', () => {
        const allPanelPermissions = String(1024n | 2048n | 16384n);
        const result = discordAPI.validateBotCanUseChannel({
            botMember: { user: { id: 'bot-user' }, roles: [] },
            roles: [{ id: 'guild-id', name: '@everyone', permissions: allPanelPermissions }],
            channel: {
                id: 'channel-id',
                guildId: 'guild-id',
                name: 'hidden',
                permissionOverwrites: [
                    { id: 'guild-id', type: 0, allow: '0', deny: '1024' }
                ]
            }
        });
        const checks = Object.fromEntries(result.checks.map(check => [check.name, check.ok]));

        expect(checks.view_channel).toBe(false);
        expect(checks.send_messages).toBe(false);
        expect(checks.embed_links).toBe(false);
        expect(result.ok).toBe(false);
    });

    test('validates bot can manage target role hierarchy and permissions', () => {
        const roles = [
            { id: 'everyone', name: '@everyone', position: 0, permissions: '0' },
            { id: 'member-role', name: 'Member', position: 2, permissions: '0', managed: false },
            { id: 'managed-role', name: 'BotRole', position: 3, permissions: '0', managed: true },
            { id: 'high-role', name: 'Admin', position: 10, permissions: '0', managed: false },
            { id: 'bot-role', name: 'MyBot', position: 8, permissions: '268435456' } // ManageRoles = 268435456
        ];
        const botMember = {
            user: { id: 'bot-user' },
            roles: ['bot-role']
        };

        // 1. Target role not found
        const notFound = discordAPI.validateBotCanManageRole({
            botMember,
            roles,
            targetRoleId: 'non-existent'
        });
        expect(notFound.ok).toBe(false);
        expect(notFound.errors).toContain('ไม่พบ role เป้าหมายในเซิร์ฟเวอร์');

        // 2. Target role is managed
        const managedRes = discordAPI.validateBotCanManageRole({
            botMember,
            roles,
            targetRoleId: 'managed-role'
        });
        expect(managedRes.ok).toBe(false);
        expect(managedRes.errors[0]).toMatch(/managed role/);

        // 3. Target role is higher than bot role
        const tooHighRes = discordAPI.validateBotCanManageRole({
            botMember,
            roles,
            targetRoleId: 'high-role'
        });
        expect(tooHighRes.ok).toBe(false);
        expect(tooHighRes.errors).toContain('ยศบอทต้องอยู่สูงกว่า role ที่จะให้');

        // 4. Valid role lower than bot role
        const validRes = discordAPI.validateBotCanManageRole({
            botMember,
            roles,
            targetRoleId: 'member-role'
        });
        expect(validRes.ok).toBe(true);
        expect(validRes.errors).toHaveLength(0);
    });

    test('toBigIntPermission safely parses permission values', () => {
        expect(discordAPI.toBigIntPermission('8')).toBe(8n);
        expect(discordAPI.toBigIntPermission(0)).toBe(0n);
        expect(discordAPI.toBigIntPermission(null)).toBe(0n);
        expect(discordAPI.toBigIntPermission(undefined)).toBe(0n);
        expect(discordAPI.toBigIntPermission('invalid')).toBe(0n);
    });
});

