'use strict';

const fs = require('node:fs');

describe('OAuth callback integration contracts', () => {
    const routeSource = fs.readFileSync('discord/verification/routes/oauth.js', 'utf8');
    const guildRouteSource = fs.readFileSync('discord/verification/routes/guild.js', 'utf8');
    const commandVerificationSource = fs.readFileSync('discord/commands/verification.js', 'utf8');
    const callbackSource = fs.readFileSync('discord/verification/public/js/callback.js', 'utf8');

    test('requests guilds.join from every verification entry point', () => {
        expect(routeSource).toContain(
            "const VERIFY_SCOPE = 'identify identify.premium email connections guilds guilds.members.read guilds.join';"
        );
        expect(guildRouteSource).toContain('return `${dashboardUrl}/auth/start?state=');
        expect(guildRouteSource).toContain('buildDiscordAuthorizeUrl(req');
        expect(commandVerificationSource).toContain(
            'const VERIFY_SCOPE = "identify identify.premium email connections guilds guilds.members.read guilds.join";'
        );
        expect(routeSource).not.toContain("ADMIN_SCOPE");
        expect(routeSource).not.toContain("/oauth/admin");
    });

    test('calls the implemented guild-member join helper', () => {
        expect(routeSource).toContain('discord.addMemberToGuild(');
        expect(routeSource).not.toContain('discord.addGuildMember(');
    });

    test('handles one-time OAuth code replay as an expected public error', () => {
        expect(routeSource).toContain('discord.isOAuthInvalidGrantError(err)');
        expect(routeSource).toContain("'oauth_code_expired_or_used'");
        expect(callbackSource).toContain('oauth_code_expired_or_used:');
        expect(callbackSource).toContain('history.replaceState');
    });

    test('does not pass callback-derived object filters directly to findOne', () => {
        expect(routeSource).not.toMatch(/IpIdentityLink\.findOne\(\s*\{/);
        expect(routeSource).not.toMatch(/GuildConfig\.findOne\(\s*\{/);
        expect(routeSource).toContain(".where('guildId').equals(safeGuildId)");
        expect(routeSource).toContain(".where('ipHash').equals(safeIpHash)");
        expect(routeSource).toContain(".where('guildId').equals(guildId)");
    });
});
