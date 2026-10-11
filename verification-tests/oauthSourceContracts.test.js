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
        expect(callbackRouteSource).toContain('oauthTokenManager.commitVerificationActivation');
        expect(callbackRouteSource).not.toContain('applyOAuthTokenStorage(updateSet, tokenData, storagePolicy)');
        expect(callbackRouteSource).not.toContain('storagePolicy = {}');
    });
});

describe('OAuth Single Authority source and architectural contracts', () => {
    const oauthTokenManager = require('../discord/core/oauthTokenManager');
    const candidateQuerySource = fs.readFileSync('discord/features/joinCampaign/services/candidateQueryService.js', 'utf8');
    const campaignWorkerSource = fs.readFileSync('discord/features/joinCampaign/worker/campaignWorker.js', 'utf8');
    const ownerServiceSource = fs.readFileSync('discord/verification/ownerService.js', 'utf8');
    const encryptionMigrationSource = fs.readFileSync('discord/verification/services/encryptionMigration.js', 'utf8');
    const lifecycleSource = fs.readFileSync('discord/verification/lifecycle.js', 'utf8');

    test('joinCampaign delegates candidate selection and token retrieval to oauthTokenManager', () => {
        expect(candidateQuerySource).toContain('require("../../../core/oauthTokenManager")');
        expect(candidateQuerySource).toContain('tokenManager.listAccessTokenCandidates(');
        expect(campaignWorkerSource).toContain('require("../../../core/oauthTokenManager")');
        expect(campaignWorkerSource).toContain('tokenManager.getAccessToken(');
        expect(candidateQuerySource).not.toMatch(/decryptToken\(/);
        expect(campaignWorkerSource).not.toMatch(/decryptToken\(/);
        expect(candidateQuerySource).not.toContain('markTokenRefreshFailure');
        expect(campaignWorkerSource).not.toContain('markTokenRefreshFailure');
    });

    test('ownerService delegates token recovery, metadata and raw reveal to oauthTokenManager', () => {
        expect(ownerServiceSource).toContain('oauthTokenManager.getRecoveryStatuses(');
        expect(ownerServiceSource).toContain('oauthTokenManager.getOwnerTokenMetadata(');
        expect(ownerServiceSource).toContain('oauthTokenManager.getOwnerTokenState(');
        expect(ownerServiceSource).not.toMatch(/\.select\([^)]*\boauth\b[^)]*\)/);
    });

    test('encryptionMigration delegates oauth_tokens to oauthTokenManager', () => {
        expect(encryptionMigrationSource).toContain('oauthTokenManager.migrateStoredTokenEncryption(');
        expect(encryptionMigrationSource).not.toContain('id: "oauth_tokens"');
    });

    test('verification lifecycle awaits oauthTokenManager.start', () => {
        expect(lifecycleSource).toContain('await tokenManager.start()');
    });

    test('oauthTokenManager encapsulates low-level crypto primitives in internal _test object', () => {
        expect(oauthTokenManager.encryptToken).toBeUndefined();
        expect(oauthTokenManager.decryptToken).toBeUndefined();
        expect(oauthTokenManager.decryptTokenForMigration).toBeUndefined();
        expect(typeof oauthTokenManager._test?.encryptToken).toBe('function');
        expect(typeof oauthTokenManager._test?.decryptToken).toBe('function');
        expect(typeof oauthTokenManager._test?.decryptTokenForMigration).toBe('function');
    });

    test('single authority invariant: no external verification/feature file calls decryptToken directly on oauth tokens', () => {
        const prodFiles = [
            'discord/verification/routes/oauth.js',
            'discord/verification/routes/oauthStart.js',
            'discord/verification/ownerService.js',
            'discord/verification/services/encryptionMigration.js',
            'discord/verification/lifecycle.js',
            'discord/features/joinCampaign/services/candidateQueryService.js',
            'discord/features/joinCampaign/worker/campaignWorker.js'
        ];
        for (const file of prodFiles) {
            const content = fs.readFileSync(file, 'utf8');
            expect(content).not.toMatch(/cryptoUtils\.decryptToken/);
        }
    });
});

