'use strict';

const {
    DEFAULT_PANEL,
    sanitizeText,
    sanitizeUrl,
    parseEmbedColor,
    normalizePanelInput,
    buildOAuthUrl,
    buildEmbed,
    buildPanelPayload,
    buildValidationSummary
} = require('../dashboard-public/utils/panelBuilder');

describe('DEFAULT_PANEL', () => {
    test('has correct default buttonText', () => {
        expect(DEFAULT_PANEL.buttonText).toBe('✅ ยืนยันตัวตน ✅');
    });

    test('has correct default verifyType', () => {
        expect(DEFAULT_PANEL.verifyType).toBe('oauth');
    });

    test('is frozen (immutable)', () => {
        expect(Object.isFrozen(DEFAULT_PANEL)).toBe(true);
    });
});

describe('sanitizeText', () => {
    test('trims whitespace', () => {
        expect(sanitizeText('  hello  ')).toBe('hello');
    });

    test('converts non-string to string', () => {
        expect(sanitizeText(42)).toBe('42');
    });

    test('handles null', () => {
        expect(sanitizeText(null)).toBe('');
    });

    test('handles undefined', () => {
        expect(sanitizeText(undefined)).toBe('');
    });

    test('truncates to max length', () => {
        const long = 'a'.repeat(3000);
        expect(sanitizeText(long, 2000)).toHaveLength(2000);
    });

    test('uses default max of 2000', () => {
        const long = 'x'.repeat(2500);
        expect(sanitizeText(long)).toHaveLength(2000);
    });

    test('allows custom max length', () => {
        expect(sanitizeText('hello world', 5)).toBe('hello');
    });
});

describe('sanitizeUrl', () => {
    test('returns empty string for null', () => {
        expect(sanitizeUrl(null)).toBe('');
    });

    test('returns empty string for undefined', () => {
        expect(sanitizeUrl(undefined)).toBe('');
    });

    test('returns empty string for empty string', () => {
        expect(sanitizeUrl('')).toBe('');
    });

    test('returns valid https URL unchanged', () => {
        const url = 'https://example.com/image.png';
        expect(sanitizeUrl(url)).toBe(url);
    });

    test('returns valid http URL', () => {
        const url = 'http://example.com/image.png';
        expect(sanitizeUrl(url)).toBe(url);
    });

    test('rejects javascript: protocol', () => {
        expect(sanitizeUrl('javascript:alert(1)')).toBe('');
    });

    test('rejects ftp: protocol', () => {
        expect(sanitizeUrl('ftp://example.com')).toBe('');
    });

    test('rejects invalid URL format', () => {
        expect(sanitizeUrl('not-a-url')).toBe('');
    });

    test('trims whitespace before validation', () => {
        expect(sanitizeUrl('  https://example.com  ')).toBe('https://example.com/');
    });
});

describe('parseEmbedColor', () => {
    test('parses hex color with # prefix', () => {
        expect(parseEmbedColor('#5865F2')).toBe(0x5865F2);
    });

    test('parses hex color without # prefix', () => {
        expect(parseEmbedColor('5865F2')).toBe(0x5865F2);
    });

    test('parses decimal color string', () => {
        expect(parseEmbedColor('5793266')).toBe(5793266);
    });

    test('returns default color for null', () => {
        expect(parseEmbedColor(null)).toBe(0x5865F2);
    });

    test('returns default color for empty string', () => {
        expect(parseEmbedColor('')).toBe(0x5865F2);
    });

    test('returns default color for invalid hex', () => {
        expect(parseEmbedColor('#GGGGGG')).toBe(0x5865F2);
    });

    test('returns default color for out-of-range number', () => {
        expect(parseEmbedColor('99999999')).toBe(0x5865F2);
    });

    test('handles lowercase hex', () => {
        expect(parseEmbedColor('#ff0000')).toBe(0xFF0000);
    });

    test('handles mixed case hex', () => {
        expect(parseEmbedColor('#Ff0000')).toBe(0xFF0000);
    });
});

describe('normalizePanelInput', () => {
    test('fills defaults for empty input', () => {
        const result = normalizePanelInput({});
        expect(result.title).toBe(DEFAULT_PANEL.title);
        expect(result.description).toBe(DEFAULT_PANEL.description);
        expect(result.buttonText).toBe(DEFAULT_PANEL.buttonText);
        expect(result.verifyType).toBe('oauth');
    });

    test('overrides defaults with provided values', () => {
        const result = normalizePanelInput({ title: 'Custom Title' });
        expect(result.title).toBe('Custom Title');
    });

    test('sanitizes title to 256 chars max', () => {
        const long = 'T'.repeat(300);
        const result = normalizePanelInput({ title: long });
        expect(result.title).toHaveLength(256);
    });

    test('sanitizes description to 4000 chars max', () => {
        const long = 'D'.repeat(5000);
        const result = normalizePanelInput({ description: long });
        expect(result.description).toHaveLength(4000);
    });

    test('falls back to image alias for imageUrl', () => {
        const result = normalizePanelInput({ image: 'https://example.com/img.png' });
        expect(result.imageUrl).toBe('https://example.com/img.png');
    });

    test('falls back to gifUrl for imageUrl', () => {
        const result = normalizePanelInput({ gifUrl: 'https://example.com/anim.gif' });
        expect(result.imageUrl).toBe('https://example.com/anim.gif');
    });

    test('falls back to thumbnail alias for thumbnailUrl', () => {
        const result = normalizePanelInput({ thumbnail: 'https://example.com/thumb.png' });
        expect(result.thumbnailUrl).toBe('https://example.com/thumb.png');
    });

    test('footerText overrides the default footer value', () => {
        const result = normalizePanelInput({ footerText: 'Custom Footer' });
        expect(result.footerText).toBe('Custom Footer');
    });

    test('falls back to url alias for titleUrl', () => {
        const result = normalizePanelInput({ url: 'https://example.com' });
        expect(result.titleUrl).toBe('https://example.com/');
    });

    test('uses buttonText over buttonLabel when buttonText provided', () => {
        // buttonText is in DEFAULT_PANEL, so buttonLabel is overridden by DEFAULT_PANEL.buttonText
        const result = normalizePanelInput({ buttonText: 'Click!' });
        expect(result.buttonText).toBe('Click!');
    });

    test('sets buttonLabel = buttonText after normalization', () => {
        const result = normalizePanelInput({ buttonText: 'Go!' });
        expect(result.buttonLabel).toBe('Go!');
    });

    test('normalizes verifyType when explicitly set in panel', () => {
        // DEFAULT_PANEL.verifyType='oauth' fills next.verifyType, so providing verifyType explicitly works
        const result = normalizePanelInput({ verifyType: 'direct-role' });
        expect(result.verifyType).toBe('direct');
    });

    test('showTimestamp is boolean', () => {
        const result = normalizePanelInput({ showTimestamp: 1 });
        expect(result.showTimestamp).toBe(true);
    });

    test('does not mutate input', () => {
        const input = { title: 'A' };
        normalizePanelInput(input);
        expect(Object.keys(input)).toHaveLength(1);
    });
});

describe('buildOAuthUrl', () => {
    test('builds correct URL with base and state', () => {
        const url = buildOAuthUrl({
            baseUrl: 'https://verify.example.com',
            state: 'abc123'
        });
        expect(url).toBe('https://verify.example.com/auth/discord?state=abc123');
    });

    test('encodes special characters in state', () => {
        const url = buildOAuthUrl({
            baseUrl: 'https://verify.example.com',
            state: 'a b=c&d'
        });
        expect(url).toContain(encodeURIComponent('a b=c&d'));
    });

    test('strips trailing slash from baseUrl', () => {
        const url = buildOAuthUrl({
            baseUrl: 'https://verify.example.com/',
            state: 'abc'
        });
        expect(url).toBe('https://verify.example.com/auth/discord?state=abc');
    });

    test('returns empty string when baseUrl missing', () => {
        expect(buildOAuthUrl({ baseUrl: '', state: 'abc' })).toBe('');
    });

    test('returns empty string when state missing', () => {
        expect(buildOAuthUrl({ baseUrl: 'https://example.com', state: '' })).toBe('');
    });

    test('returns empty string when both missing', () => {
        expect(buildOAuthUrl({})).toBe('');
    });
});

describe('buildEmbed', () => {
    const basePanel = {
        title: 'Test Title',
        description: 'Test Description',
        color: '#5865F2',
        titleUrl: '',
        imageUrl: '',
        thumbnailUrl: '',
        footerText: '',
        showTimestamp: false
    };

    test('builds embed with title and description', () => {
        const embed = buildEmbed(basePanel);
        expect(embed.title).toBe('Test Title');
        expect(embed.description).toBe('Test Description');
    });

    test('converts color to integer', () => {
        const embed = buildEmbed(basePanel);
        expect(embed.color).toBe(0x5865F2);
    });

    test('adds url when titleUrl is set', () => {
        const embed = buildEmbed({ ...basePanel, titleUrl: 'https://example.com' });
        expect(embed.url).toBe('https://example.com');
    });

    test('does not add url when titleUrl is empty', () => {
        const embed = buildEmbed(basePanel);
        expect(embed.url).toBeUndefined();
    });

    test('adds image when imageUrl is set', () => {
        const embed = buildEmbed({ ...basePanel, imageUrl: 'https://example.com/img.png' });
        expect(embed.image).toEqual({ url: 'https://example.com/img.png' });
    });

    test('does not add image when imageUrl is empty', () => {
        const embed = buildEmbed(basePanel);
        expect(embed.image).toBeUndefined();
    });

    test('adds thumbnail when thumbnailUrl is set', () => {
        const embed = buildEmbed({ ...basePanel, thumbnailUrl: 'https://example.com/thumb.png' });
        expect(embed.thumbnail).toEqual({ url: 'https://example.com/thumb.png' });
    });

    test('adds footer when footerText is set', () => {
        const embed = buildEmbed({ ...basePanel, footerText: 'My Footer' });
        expect(embed.footer).toEqual({ text: 'My Footer' });
    });

    test('does not add footer when footerText is empty', () => {
        const embed = buildEmbed(basePanel);
        expect(embed.footer).toBeUndefined();
    });

    test('adds timestamp when showTimestamp is true', () => {
        const embed = buildEmbed({ ...basePanel, showTimestamp: true });
        expect(embed.timestamp).toBeDefined();
        expect(typeof embed.timestamp).toBe('string');
    });

    test('does not add timestamp when showTimestamp is false', () => {
        const embed = buildEmbed(basePanel);
        expect(embed.timestamp).toBeUndefined();
    });
});

describe('buildPanelPayload', () => {
    const oauthUrl = 'https://verify.example.com/auth/discord?state=test123';

    test('returns object with content, embeds, components, allowed_mentions', () => {
        const payload = buildPanelPayload({ panel: {}, oauthUrl });
        expect(payload).toHaveProperty('content');
        expect(payload).toHaveProperty('embeds');
        expect(payload).toHaveProperty('components');
        expect(payload).toHaveProperty('allowed_mentions');
    });

    test('embeds array has one embed', () => {
        const payload = buildPanelPayload({ panel: {}, oauthUrl });
        expect(payload.embeds).toHaveLength(1);
    });

    test('components array has one action row', () => {
        const payload = buildPanelPayload({ panel: {}, oauthUrl });
        expect(payload.components).toHaveLength(1);
        expect(payload.components[0].type).toBe(1);
    });

    test('action row contains one button', () => {
        const payload = buildPanelPayload({ panel: {}, oauthUrl });
        const buttons = payload.components[0].components;
        expect(buttons).toHaveLength(1);
    });

    test('oauth mode button uses style 5 (link)', () => {
        const payload = buildPanelPayload({
            panel: { verifyType: 'oauth' },
            oauthUrl
        });
        const btn = payload.components[0].components[0];
        expect(btn.style).toBe(5);
        expect(btn.url).toBe(oauthUrl);
    });

    test('direct mode button uses style 2 (secondary) with custom_id', () => {
        const payload = buildPanelPayload({
            panel: { verifyType: 'direct' },
            directCustomId: 'verify_direct'
        });
        const btn = payload.components[0].components[0];
        expect(btn.style).toBe(2);
        expect(btn.custom_id).toBe('verify_direct');
    });

    test('direct mode uses default custom_id when not provided', () => {
        const payload = buildPanelPayload({ panel: { verifyType: 'direct' } });
        const btn = payload.components[0].components[0];
        expect(btn.custom_id).toBe('verify_direct_role');
    });

    test('button label comes from panel buttonText', () => {
        const payload = buildPanelPayload({
            panel: { buttonText: 'Verify Me!', verifyType: 'oauth' },
            oauthUrl
        });
        const btn = payload.components[0].components[0];
        expect(btn.label).toBe('Verify Me!');
    });

    test('allowed_mentions defaults to { parse: [] }', () => {
        const payload = buildPanelPayload({ panel: {}, oauthUrl });
        expect(payload.allowed_mentions).toEqual({ parse: [] });
    });
});

describe('buildValidationSummary', () => {
    test('ok=true when no errors and all checks pass', () => {
        const result = buildValidationSummary({
            ok: true,
            checks: [{ ok: true }],
            warnings: [],
            errors: []
        });
        expect(result.ok).toBe(true);
    });

    test('ok=false when errors exist even if ok=true passed', () => {
        const result = buildValidationSummary({
            ok: true,
            checks: [],
            warnings: [],
            errors: ['Something is wrong']
        });
        expect(result.ok).toBe(false);
    });

    test('ok=false when any check fails', () => {
        const result = buildValidationSummary({
            ok: true,
            checks: [{ ok: false, label: 'Failed check' }],
            warnings: [],
            errors: []
        });
        expect(result.ok).toBe(false);
    });

    test('ok=false when ok param is false regardless of checks', () => {
        const result = buildValidationSummary({
            ok: false,
            checks: [{ ok: true }],
            warnings: [],
            errors: []
        });
        expect(result.ok).toBe(false);
    });

    test('returns checks array', () => {
        const checks = [{ ok: true, label: 'Check 1' }];
        const result = buildValidationSummary({ ok: true, checks, warnings: [], errors: [] });
        expect(result.checks).toEqual(checks);
    });

    test('returns warnings array', () => {
        const warnings = ['Warning 1'];
        const result = buildValidationSummary({ ok: true, checks: [], warnings, errors: [] });
        expect(result.warnings).toEqual(warnings);
    });

    test('returns errors array', () => {
        const errors = ['Error 1'];
        const result = buildValidationSummary({ ok: false, checks: [], warnings: [], errors });
        expect(result.errors).toEqual(errors);
    });

    test('handles empty checks by default', () => {
        const result = buildValidationSummary({ ok: true });
        expect(result.checks).toEqual([]);
        expect(result.warnings).toEqual([]);
        expect(result.errors).toEqual([]);
        expect(result.ok).toBe(true);
    });
});