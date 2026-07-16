'use strict';

/**
 * Tests for discord/verification/utils/verifyMode.js
 *
 * Covers the new/changed exports from the PR:
 *   - POLICY_ACTIONS constant
 *   - DEFAULT_ANTI_ALT constant
 *   - normalizeAction()
 *   - clampNumber()
 *   - normalizeAntiAltConfig()
 *   - normalizeVerificationConfig() – blockHosting + antiAlt normalization
 */

const {
    VERIFY_MODES,
    POLICY_ACTIONS,
    RULE_ACTIONS,
    SECURITY_RULE_KEYS,
    DEFAULT_ANTI_ALT,
    normalizeAction,
    clampNumber,
    normalizeAntiAltConfig,
    normalizeRuleAction,
    normalizeSecurityRules,
    normalizeVerificationConfig,
} = require('../discord/verification/utils/verifyMode');

describe('independent verification security rules', () => {
    test('supports the Discord moderation actions exposed by the Owner UI', () => {
        expect(RULE_ACTIONS).toEqual(['allow', 'deny_role', 'timeout', 'kick', 'ban']);
        expect(SECURITY_RULE_KEYS).toHaveLength(7);
        expect(normalizeRuleAction('BLOCK')).toBe('deny_role');
        expect(normalizeRuleAction('timeout')).toBe('timeout');
    });

    test('normalizes every rule independently without a global Anti-Alt switch', () => {
        const rules = normalizeSecurityRules({
            ipDuplicate: { enabled: true, action: 'kick', threshold: 4 },
            deviceDuplicate: { enabled: false, action: 'ban', threshold: 2 },
            spoofedHeader: { enabled: true, action: 'timeout', timeoutMinutes: 90 }
        }, { blockVPN: false });

        expect(rules.ipDuplicate).toMatchObject({ enabled: true, action: 'kick', threshold: 4 });
        expect(rules.deviceDuplicate).toMatchObject({ enabled: false, action: 'ban', threshold: 2 });
        expect(rules.spoofedHeader).toMatchObject({ enabled: true, action: 'timeout', timeoutMinutes: 90 });
        expect(rules.vpnProxyTor.enabled).toBe(false);
    });

    test('migrates legacy Anti-Alt actions without preserving delay as fake moderation', () => {
        const rules = normalizeSecurityRules({}, {
            blockVPN: true,
            antiAlt: { enabled: true, ipDuplicateAction: 'block', maxUsersPerIp: 5, unknownLookupAction: 'delay' }
        });

        expect(rules.vpnProxyTor).toMatchObject({ enabled: true, action: 'deny_role' });
        expect(rules.ipDuplicate).toMatchObject({ enabled: true, action: 'deny_role', threshold: 5 });
        expect(rules.unknownLookup).toMatchObject({ enabled: true, action: 'allow' });
    });
});

// ---------------------------------------------------------------------------
// POLICY_ACTIONS constant
// ---------------------------------------------------------------------------
describe('POLICY_ACTIONS', () => {
    test('contains exactly the four expected action strings', () => {
        expect(POLICY_ACTIONS).toEqual(['off', 'log_only', 'delay', 'block']);
    });

    test('is frozen', () => {
        expect(Object.isFrozen(POLICY_ACTIONS)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// DEFAULT_ANTI_ALT constant
// ---------------------------------------------------------------------------
describe('DEFAULT_ANTI_ALT', () => {
    test('has enabled = false by default', () => {
        expect(DEFAULT_ANTI_ALT.enabled).toBe(false);
    });

    test('has log_only defaults for ip/device duplicate actions', () => {
        expect(DEFAULT_ANTI_ALT.ipDuplicateAction).toBe('log_only');
        expect(DEFAULT_ANTI_ALT.deviceDuplicateAction).toBe('log_only');
    });

    test('has delay defaults for risk actions', () => {
        expect(DEFAULT_ANTI_ALT.previouslyBlockedIpAction).toBe('delay');
        expect(DEFAULT_ANTI_ALT.spoofedHeaderAction).toBe('delay');
        expect(DEFAULT_ANTI_ALT.unknownLookupAction).toBe('delay');
    });

    test('has sensible numeric defaults', () => {
        expect(DEFAULT_ANTI_ALT.maxUsersPerIp).toBe(3);
        expect(DEFAULT_ANTI_ALT.maxUsersPerDevice).toBe(2);
        expect(DEFAULT_ANTI_ALT.delayMs).toBe(5000);
    });

    test('is frozen', () => {
        expect(Object.isFrozen(DEFAULT_ANTI_ALT)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// normalizeAction()
// ---------------------------------------------------------------------------
describe('normalizeAction', () => {
    test.each(['off', 'log_only', 'delay', 'block'])(
        'returns %s unchanged when it is a valid action',
        (action) => {
            expect(normalizeAction(action)).toBe(action);
        }
    );

    test('returns default fallback log_only for unknown string', () => {
        expect(normalizeAction('invalid')).toBe('log_only');
        expect(normalizeAction('BLOCK')).toBe('block'); // case-insensitive
    });

    test('case-insensitive matching', () => {
        expect(normalizeAction('DELAY')).toBe('delay');
        expect(normalizeAction('Log_Only')).toBe('log_only');
        expect(normalizeAction('OFF')).toBe('off');
        expect(normalizeAction('BLOCK')).toBe('block');
    });

    test('trims whitespace before matching', () => {
        expect(normalizeAction('  delay  ')).toBe('delay');
        expect(normalizeAction('\tblock\n')).toBe('block');
    });

    test('falls back to specified fallback when value is invalid', () => {
        expect(normalizeAction('garbage', 'delay')).toBe('delay');
        expect(normalizeAction('garbage', 'block')).toBe('block');
        expect(normalizeAction('garbage', 'off')).toBe('off');
    });

    test('uses log_only when the given fallback is also invalid', () => {
        expect(normalizeAction('garbage', 'also_invalid')).toBe('log_only');
    });

    test('handles null / undefined / empty string gracefully', () => {
        expect(normalizeAction(null)).toBe('log_only');
        expect(normalizeAction(undefined)).toBe('log_only');
        expect(normalizeAction('')).toBe('log_only');
        expect(normalizeAction(0)).toBe('log_only');
    });

    test('handles non-string values', () => {
        expect(normalizeAction(123)).toBe('log_only');
        expect(normalizeAction({})).toBe('log_only');
        expect(normalizeAction([])).toBe('log_only');
    });

    // regression: make sure 'off' passes through (edge case – falsy-like intent)
    test('off is a valid action and is not confused with a falsy value', () => {
        expect(normalizeAction('off')).toBe('off');
    });
});

// ---------------------------------------------------------------------------
// clampNumber()
// ---------------------------------------------------------------------------
describe('clampNumber', () => {
    test('returns value within [min, max] unchanged', () => {
        expect(clampNumber(5, 1, 10, 3)).toBe(5);
        expect(clampNumber(1, 1, 10, 3)).toBe(1);
        expect(clampNumber(10, 1, 10, 3)).toBe(10);
    });

    test('clamps to min when value is below range', () => {
        expect(clampNumber(0, 1, 20, 3)).toBe(1);
        expect(clampNumber(-100, 1, 20, 3)).toBe(1);
    });

    test('clamps to max when value is above range', () => {
        expect(clampNumber(25, 1, 20, 3)).toBe(20);
        expect(clampNumber(9999, 0, 10000, 5000)).toBe(9999);
        expect(clampNumber(10001, 0, 10000, 5000)).toBe(10000);
    });

    test('floors decimal values', () => {
        expect(clampNumber(3.9, 1, 20, 3)).toBe(3);
        expect(clampNumber(2.1, 1, 20, 3)).toBe(2);
        expect(clampNumber(10.99, 1, 20, 3)).toBe(10);
    });

    test('returns fallback for non-finite values', () => {
        expect(clampNumber(NaN, 1, 20, 3)).toBe(3);
        expect(clampNumber(Infinity, 1, 20, 3)).toBe(3);
        expect(clampNumber(-Infinity, 1, 20, 3)).toBe(3);
    });

    test('returns fallback for non-numeric strings that cannot be converted', () => {
        expect(clampNumber('abc', 1, 20, 3)).toBe(3);
        // null → Number(null) = 0, which is finite and below min=1, so clamped to 1
        expect(clampNumber(null, 1, 20, 3)).toBe(1);
        expect(clampNumber(undefined, 1, 20, 3)).toBe(3);
    });

    test('converts numeric strings correctly', () => {
        expect(clampNumber('5', 1, 10, 3)).toBe(5);
        expect(clampNumber('15', 1, 10, 3)).toBe(10);
        expect(clampNumber('0', 1, 10, 3)).toBe(1);
    });

    test('handles zero min bound (delayMs use-case)', () => {
        expect(clampNumber(0, 0, 10000, 5000)).toBe(0);
        expect(clampNumber(-1, 0, 10000, 5000)).toBe(0);
        expect(clampNumber(10000, 0, 10000, 5000)).toBe(10000);
        expect(clampNumber(10001, 0, 10000, 5000)).toBe(10000);
    });
});

// ---------------------------------------------------------------------------
// normalizeAntiAltConfig()
// ---------------------------------------------------------------------------
describe('normalizeAntiAltConfig', () => {
    test('returns defaults when called with empty object', () => {
        const result = normalizeAntiAltConfig({});
        expect(result.enabled).toBe(false);
        expect(result.ipDuplicateAction).toBe('log_only');
        expect(result.maxUsersPerIp).toBe(3);
        expect(result.deviceDuplicateAction).toBe('log_only');
        expect(result.maxUsersPerDevice).toBe(2);
        expect(result.previouslyBlockedIpAction).toBe('delay');
        expect(result.spoofedHeaderAction).toBe('delay');
        expect(result.unknownLookupAction).toBe('delay');
        expect(result.delayMs).toBe(5000);
    });

    test('returns defaults when called with no arguments', () => {
        const result = normalizeAntiAltConfig();
        expect(result.enabled).toBe(false);
        expect(result.maxUsersPerIp).toBe(3);
    });

    test('accepts enabled = true', () => {
        expect(normalizeAntiAltConfig({ enabled: true }).enabled).toBe(true);
    });

    test('does NOT accept enabled = "true" (truthy string)', () => {
        // enabled must be strictly true
        expect(normalizeAntiAltConfig({ enabled: 'true' }).enabled).toBe(false);
        expect(normalizeAntiAltConfig({ enabled: 1 }).enabled).toBe(false);
    });

    test('normalizes action fields to valid POLICY_ACTIONS values', () => {
        const cfg = normalizeAntiAltConfig({
            ipDuplicateAction: 'block',
            deviceDuplicateAction: 'off',
            previouslyBlockedIpAction: 'delay',
            spoofedHeaderAction: 'log_only',
            unknownLookupAction: 'block'
        });
        expect(cfg.ipDuplicateAction).toBe('block');
        expect(cfg.deviceDuplicateAction).toBe('off');
        expect(cfg.previouslyBlockedIpAction).toBe('delay');
        expect(cfg.spoofedHeaderAction).toBe('log_only');
        expect(cfg.unknownLookupAction).toBe('block');
    });

    test('falls back to defaults for invalid action strings', () => {
        const cfg = normalizeAntiAltConfig({
            ipDuplicateAction: 'nuke',
            deviceDuplicateAction: null,
            previouslyBlockedIpAction: 'DELAY', // uppercase
        });
        expect(cfg.ipDuplicateAction).toBe('log_only');
        expect(cfg.deviceDuplicateAction).toBe('log_only');
        expect(cfg.previouslyBlockedIpAction).toBe('delay'); // case-normalized
    });

    test('clamps maxUsersPerIp within [1, 20]', () => {
        expect(normalizeAntiAltConfig({ maxUsersPerIp: 0 }).maxUsersPerIp).toBe(1);
        expect(normalizeAntiAltConfig({ maxUsersPerIp: 21 }).maxUsersPerIp).toBe(20);
        expect(normalizeAntiAltConfig({ maxUsersPerIp: 5 }).maxUsersPerIp).toBe(5);
    });

    test('clamps maxUsersPerDevice within [1, 20]', () => {
        expect(normalizeAntiAltConfig({ maxUsersPerDevice: -1 }).maxUsersPerDevice).toBe(1);
        expect(normalizeAntiAltConfig({ maxUsersPerDevice: 100 }).maxUsersPerDevice).toBe(20);
        expect(normalizeAntiAltConfig({ maxUsersPerDevice: 3 }).maxUsersPerDevice).toBe(3);
    });

    test('clamps delayMs within [0, 10000]', () => {
        expect(normalizeAntiAltConfig({ delayMs: -500 }).delayMs).toBe(0);
        expect(normalizeAntiAltConfig({ delayMs: 20000 }).delayMs).toBe(10000);
        expect(normalizeAntiAltConfig({ delayMs: 3000 }).delayMs).toBe(3000);
    });

    test('returns defaults when called with a non-object (array)', () => {
        const result = normalizeAntiAltConfig([{ enabled: true }]);
        expect(result.enabled).toBe(false);
    });

    test('returns defaults when called with null', () => {
        const result = normalizeAntiAltConfig(null);
        expect(result.enabled).toBe(false);
    });

    test('returns defaults when called with a primitive', () => {
        const result = normalizeAntiAltConfig('block');
        expect(result.enabled).toBe(false);
    });

    test('full valid config round-trips correctly', () => {
        const input = {
            enabled: true,
            ipDuplicateAction: 'block',
            maxUsersPerIp: 5,
            deviceDuplicateAction: 'delay',
            maxUsersPerDevice: 4,
            previouslyBlockedIpAction: 'block',
            spoofedHeaderAction: 'block',
            unknownLookupAction: 'log_only',
            delayMs: 7500
        };
        const result = normalizeAntiAltConfig(input);
        expect(result).toMatchObject({
            enabled: true,
            ipDuplicateAction: 'block',
            maxUsersPerIp: 5,
            deviceDuplicateAction: 'delay',
            maxUsersPerDevice: 4,
            previouslyBlockedIpAction: 'block',
            spoofedHeaderAction: 'block',
            unknownLookupAction: 'log_only',
            delayMs: 7500
        });
    });

    // Regression: delayMs = 0 is valid (no delay)
    test('delayMs = 0 is preserved (valid boundary)', () => {
        expect(normalizeAntiAltConfig({ delayMs: 0 }).delayMs).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// normalizeVerificationConfig() – blockHosting + antiAlt additions from PR
// ---------------------------------------------------------------------------
describe('normalizeVerificationConfig – blockHosting and antiAlt (PR additions)', () => {
    test('blockHosting defaults to false when not provided', () => {
        const result = normalizeVerificationConfig({});
        expect(result.blockHosting).toBe(false);
    });

    test('blockHosting = true is preserved', () => {
        const result = normalizeVerificationConfig({ blockHosting: true });
        expect(result.blockHosting).toBe(true);
    });

    test('blockHosting truthy non-boolean values are coerced to false', () => {
        // Only strict true is accepted
        expect(normalizeVerificationConfig({ blockHosting: 1 }).blockHosting).toBe(false);
        expect(normalizeVerificationConfig({ blockHosting: 'true' }).blockHosting).toBe(false);
        expect(normalizeVerificationConfig({ blockHosting: 'yes' }).blockHosting).toBe(false);
    });

    test('antiAlt is NOT normalized when key is absent (no own property)', () => {
        const input = { blockVPN: true };
        const result = normalizeVerificationConfig(input);
        // antiAlt key should not be injected when not present
        expect(result.hasOwnProperty('antiAlt')).toBe(false);
    });

    test('antiAlt is normalized when the key is present', () => {
        const result = normalizeVerificationConfig({ antiAlt: { enabled: true, maxUsersPerIp: 7 } });
        expect(result.antiAlt).toBeDefined();
        expect(result.antiAlt.enabled).toBe(true);
        expect(result.antiAlt.maxUsersPerIp).toBe(7);
    });

    test('antiAlt null/undefined is normalized to defaults when key is present', () => {
        const result = normalizeVerificationConfig({ antiAlt: null });
        expect(result.antiAlt.enabled).toBe(false);
        expect(result.antiAlt.maxUsersPerIp).toBe(3);
    });

    test('antiAlt with invalid actions falls back to defaults', () => {
        const result = normalizeVerificationConfig({
            antiAlt: {
                enabled: true,
                ipDuplicateAction: 'explode',
                spoofedHeaderAction: 'BAD'
            }
        });
        expect(result.antiAlt.ipDuplicateAction).toBe('log_only');
        expect(result.antiAlt.spoofedHeaderAction).toBe('delay');
    });

    test('full config normalizes blockHosting + antiAlt together', () => {
        const result = normalizeVerificationConfig({
            blockVPN: true,
            blockHosting: true,
            antiAlt: {
                enabled: true,
                ipDuplicateAction: 'block',
                maxUsersPerIp: 10,
                delayMs: 2000
            }
        });
        expect(result.blockHosting).toBe(true);
        expect(result.antiAlt.enabled).toBe(true);
        expect(result.antiAlt.ipDuplicateAction).toBe('block');
        expect(result.antiAlt.maxUsersPerIp).toBe(10);
        expect(result.antiAlt.delayMs).toBe(2000);
    });

    test('preserves existing verify mode fields alongside new PR fields', () => {
        const result = normalizeVerificationConfig({
            verifyType: 'oauth',
            blockVPN: false,
            blockHosting: true
        });
        expect(result.verifyType).toBe(VERIFY_MODES.OAUTH);
        expect(result.blockHosting).toBe(true);
    });

    test('preserves explicit false legacy mode values as direct mode', () => {
        expect(normalizeVerificationConfig({ verifyType: false }).verifyType)
            .toBe(VERIFY_MODES.DIRECT);
        expect(normalizeVerificationConfig({ oauthMode: false }).verifyType)
            .toBe(VERIFY_MODES.DIRECT);
    });

    // Regression: blockHosting = false must not be converted to true
    test('blockHosting = false stays false', () => {
        expect(normalizeVerificationConfig({ blockHosting: false }).blockHosting).toBe(false);
    });
});
