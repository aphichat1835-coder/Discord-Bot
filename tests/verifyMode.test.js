'use strict';

const {
    VERIFY_MODES,
    normalizeVerifyMode,
    toLegacyCommandVerifyMode,
    toDashboardVerifyMode,
    isOauthMode,
    isDirectMode,
    getVerifyModeLabel,
    normalizePanel,
    normalizeVerificationConfig
} = require('../dashboard-public/utils/verifyMode');

describe('VERIFY_MODES constants', () => {
    test('OAUTH is "oauth"', () => {
        expect(VERIFY_MODES.OAUTH).toBe('oauth');
    });

    test('DIRECT is "direct"', () => {
        expect(VERIFY_MODES.DIRECT).toBe('direct');
    });

    test('constants are frozen (immutable)', () => {
        expect(() => {
            VERIFY_MODES.OAUTH = 'changed';
        }).toThrow();
    });
});

describe('normalizeVerifyMode', () => {
    describe('OAuth mode mappings', () => {
        const oauthInputs = [
            'oauth',
            'oauth2',
            'discord-oauth',
            'discord_oauth',
            'direct-discord-authorize-long-lived-state'
        ];

        test.each(oauthInputs)('maps "%s" to "oauth"', (input) => {
            expect(normalizeVerifyMode(input)).toBe('oauth');
        });

        test('maps uppercase "OAUTH" to "oauth" (case-insensitive)', () => {
            expect(normalizeVerifyMode('OAUTH')).toBe('oauth');
        });

        test('maps "OAuth2" to "oauth" (mixed case)', () => {
            expect(normalizeVerifyMode('OAuth2')).toBe('oauth');
        });
    });

    describe('Direct mode mappings', () => {
        const directInputs = [
            'direct',
            'direct-role',
            'direct_role',
            'instant',
            'instant-role',
            'button'
        ];

        test.each(directInputs)('maps "%s" to "direct"', (input) => {
            expect(normalizeVerifyMode(input)).toBe('direct');
        });

        test('maps uppercase "DIRECT" to "direct" (case-insensitive)', () => {
            expect(normalizeVerifyMode('DIRECT')).toBe('direct');
        });
    });

    describe('Default/fallback behavior', () => {
        test('empty string returns "oauth"', () => {
            expect(normalizeVerifyMode('')).toBe('oauth');
        });

        test('null returns "oauth"', () => {
            expect(normalizeVerifyMode(null)).toBe('oauth');
        });

        test('undefined returns "oauth"', () => {
            expect(normalizeVerifyMode(undefined)).toBe('oauth');
        });

        test('unknown string returns "oauth"', () => {
            expect(normalizeVerifyMode('foobar')).toBe('oauth');
        });

        test('whitespace-only string returns "oauth"', () => {
            expect(normalizeVerifyMode('   ')).toBe('oauth');
        });

        test('trims whitespace before normalizing', () => {
            expect(normalizeVerifyMode('  direct  ')).toBe('direct');
        });
    });
});

describe('toLegacyCommandVerifyMode', () => {
    test('oauth mode returns "oauth2"', () => {
        expect(toLegacyCommandVerifyMode('oauth')).toBe('oauth2');
    });

    test('oauth2 returns "oauth2"', () => {
        expect(toLegacyCommandVerifyMode('oauth2')).toBe('oauth2');
    });

    test('direct mode returns "direct-role"', () => {
        expect(toLegacyCommandVerifyMode('direct')).toBe('direct-role');
    });

    test('direct-role returns "direct-role"', () => {
        expect(toLegacyCommandVerifyMode('direct-role')).toBe('direct-role');
    });

    test('instant returns "direct-role"', () => {
        expect(toLegacyCommandVerifyMode('instant')).toBe('direct-role');
    });

    test('empty string defaults to "oauth2"', () => {
        expect(toLegacyCommandVerifyMode('')).toBe('oauth2');
    });
});

describe('toDashboardVerifyMode', () => {
    test('delegates to normalizeVerifyMode - oauth', () => {
        expect(toDashboardVerifyMode('oauth2')).toBe('oauth');
    });

    test('delegates to normalizeVerifyMode - direct', () => {
        expect(toDashboardVerifyMode('button')).toBe('direct');
    });
});

describe('isOauthMode', () => {
    test('returns true for "oauth"', () => {
        expect(isOauthMode('oauth')).toBe(true);
    });

    test('returns true for "oauth2"', () => {
        expect(isOauthMode('oauth2')).toBe(true);
    });

    test('returns false for "direct"', () => {
        expect(isOauthMode('direct')).toBe(false);
    });

    test('returns false for "button"', () => {
        expect(isOauthMode('button')).toBe(false);
    });

    test('returns true for empty string (default is oauth)', () => {
        expect(isOauthMode('')).toBe(true);
    });
});

describe('isDirectMode', () => {
    test('returns true for "direct"', () => {
        expect(isDirectMode('direct')).toBe(true);
    });

    test('returns true for "instant"', () => {
        expect(isDirectMode('instant')).toBe(true);
    });

    test('returns false for "oauth"', () => {
        expect(isDirectMode('oauth')).toBe(false);
    });

    test('returns false for empty string', () => {
        expect(isDirectMode('')).toBe(false);
    });
});

describe('getVerifyModeLabel', () => {
    test('returns Thai label for direct mode', () => {
        expect(getVerifyModeLabel('direct')).toBe('กดรับยศทันที');
    });

    test('returns label for instant (direct alias)', () => {
        expect(getVerifyModeLabel('instant')).toBe('กดรับยศทันที');
    });

    test('returns OAuth2 label for oauth mode', () => {
        expect(getVerifyModeLabel('oauth')).toBe('OAuth2 Verification');
    });

    test('returns OAuth2 label for empty string (default)', () => {
        expect(getVerifyModeLabel('')).toBe('OAuth2 Verification');
    });
});

describe('normalizePanel', () => {
    test('sets verifyType from verifyType field', () => {
        const result = normalizePanel({ verifyType: 'direct' });
        expect(result.verifyType).toBe('direct');
    });

    test('falls back to oauthMode if verifyType missing', () => {
        const result = normalizePanel({ oauthMode: 'direct-role' });
        expect(result.verifyType).toBe('direct');
    });

    test('falls back to mode if verifyType and oauthMode missing', () => {
        const result = normalizePanel({ mode: 'button' });
        expect(result.verifyType).toBe('direct');
    });

    test('defaults verifyType to oauth when no mode specified', () => {
        const result = normalizePanel({});
        expect(result.verifyType).toBe('oauth');
    });

    test('copies buttonLabel to buttonText when buttonText is missing', () => {
        const result = normalizePanel({ buttonLabel: 'Click Me' });
        expect(result.buttonText).toBe('Click Me');
        expect(result.buttonLabel).toBe('Click Me');
    });

    test('copies buttonText to buttonLabel when buttonLabel is missing', () => {
        const result = normalizePanel({ buttonText: 'Verify Now' });
        expect(result.buttonLabel).toBe('Verify Now');
    });

    test('sets default buttonText when neither buttonText nor buttonLabel provided', () => {
        const result = normalizePanel({});
        expect(result.buttonText).toBe('✅ ยืนยันตัวตน ✅');
    });

    test('sets default buttonLabel from buttonText default', () => {
        const result = normalizePanel({});
        expect(result.buttonLabel).toBe('✅ ยืนยันตัวตน ✅');
    });

    test('preserves other panel properties', () => {
        const input = { title: 'Test', color: '#ff0000', extra: 'keep' };
        const result = normalizePanel(input);
        expect(result.title).toBe('Test');
        expect(result.color).toBe('#ff0000');
        expect(result.extra).toBe('keep');
    });

    test('does not mutate input object', () => {
        const input = { verifyType: 'oauth' };
        normalizePanel(input);
        expect(Object.keys(input)).toHaveLength(1);
    });
});

describe('normalizeVerificationConfig', () => {
    test('normalizes verifyType from config', () => {
        const result = normalizeVerificationConfig({ verifyType: 'direct' });
        expect(result.verifyType).toBe('direct');
    });

    test('sets oauthMode equal to verifyType', () => {
        const result = normalizeVerificationConfig({ verifyType: 'direct' });
        expect(result.oauthMode).toBe('direct');
    });

    test('oauthMode equals verifyType for oauth', () => {
        const result = normalizeVerificationConfig({ verifyType: 'oauth' });
        expect(result.oauthMode).toBe('oauth');
    });

    test('normalizes nested panel', () => {
        const result = normalizeVerificationConfig({
            panel: { verifyType: 'instant' }
        });
        expect(result.panel.verifyType).toBe('direct');
    });

    test('handles empty config', () => {
        const result = normalizeVerificationConfig({});
        expect(result.verifyType).toBe('oauth');
        expect(result.oauthMode).toBe('oauth');
        expect(result.panel).toBeDefined();
    });

    test('falls back to panel.verifyType when config.verifyType is missing', () => {
        const result = normalizeVerificationConfig({
            panel: { verifyType: 'button' }
        });
        expect(result.verifyType).toBe('direct');
    });

    test('does not mutate original config', () => {
        const config = { verifyType: 'oauth' };
        normalizeVerificationConfig(config);
        expect(config).toEqual({ verifyType: 'oauth' });
    });
});
