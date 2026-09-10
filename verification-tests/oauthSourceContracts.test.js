'use strict';

const fs = require('node:fs');

describe('OAuth callback integration contracts', () => {
    const callbackRouteSource = fs.readFileSync('discord/verification/routes/oauth.js', 'utf8');
    const oauthStartRouteSource = fs.readFileSync('discord/verification/routes/oauthStart.js', 'utf8');
    const guildRouteSource = fs.readFileSync('discord/verification/routes/guild.js', 'utf8');
    const commandVerificationSource = fs.readFileSync('discord/commands/verification.js', 'utf8');
    const callbackSource = fs.readFileSync('discord/verification/public/js/callback.js', 'utf8');

    test('requests guilds.join from every verification entry point', () => {
        expect(oauthStartRouteSource).toContain(
            'const VERIFY_SCOPE = "identify email connections guilds guilds.members.read guilds.join";'
        );
        expect(guildRouteSource).toContain('return `${dashboardUrl}/auth/start?state=');
        expect(guildRouteSource).toContain('buildDiscordAuthorizeUrl(req');
        expect(commandVerificationSource).toContain(
            'const VERIFY_SCOPE = "identify email connections guilds guilds.members.read guilds.join";'
        );
        expect(commandVerificationSource).toContain('https://discord.com/oauth2/authorize?');
        expect(oauthStartRouteSource).not.toContain("identify.premium");
        expect(commandVerificationSource).not.toContain("identify.premium");
        expect(oauthStartRouteSource).not.toContain("ADMIN_SCOPE");
        expect(oauthStartRouteSource).not.toContain("/oauth/admin");
    });

    test('calls the implemented guild-member join helper', () => {
        expect(callbackRouteSource).toContain('discord.addMemberToGuild(');
        expect(callbackRouteSource).not.toContain('discord.addGuildMember(');
    });

    test('handles one-time OAuth code replay as an expected public error', () => {
        expect(callbackRouteSource).toContain('discord.isOAuthInvalidGrantError(err)');
        expect(callbackRouteSource).toContain("'oauth_code_expired_or_used'");
        expect(callbackSource).toContain('oauth_code_expired_or_used:');
        expect(callbackSource).toContain('history.replaceState');
    });

    test('does not pass callback-derived object filters directly to findOne', () => {
        expect(callbackRouteSource).not.toMatch(/IpIdentityLink\.findOne\(\s*\{/);
        expect(callbackRouteSource).not.toMatch(/GuildConfig\.findOne\(\s*\{/);
        expect(callbackRouteSource).toContain(".where('guildId').equals(safeGuildId)");
        expect(callbackRouteSource).toContain(".where('ipHash').equals(safeIpHash)");
        expect(callbackRouteSource).toContain(".where('guildId').equals(guildId)");
    });

    test('uses a fixed Discord authorize target and an explicit forced token-storage contract', () => {
        expect(oauthStartRouteSource).toContain('return `https://discord.com/oauth2/authorize?${params.toString()}`;');
        expect(oauthStartRouteSource).toContain('const VERIFY_SCOPE = "identify email connections guilds guilds.members.read guilds.join";');
        expect(callbackRouteSource).toContain('applyForcedOAuthTokenStorage(updateSet, tokenData);');
        expect(callbackRouteSource).not.toContain('applyOAuthTokenStorage(updateSet, tokenData, storagePolicy)');
        expect(callbackRouteSource).not.toContain('storagePolicy = {}');
    });
});
