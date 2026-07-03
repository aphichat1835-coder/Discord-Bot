'use strict';

const fs = require('node:fs');

describe('OAuth callback integration contracts', () => {
    const routeSource = fs.readFileSync('routes/oauth.js', 'utf8');
    const callbackSource = fs.readFileSync('public/js/callback.js', 'utf8');

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
});
