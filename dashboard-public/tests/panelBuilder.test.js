'use strict';

/**
 * Tests for dashboard-public/utils/panelBuilder.js
 *
 * Covers: sanitizeText, sanitizeUrl, parseEmbedColor,
 *         normalizePanelInput, buildOAuthUrl, buildEmbed,
 *         buildPanelPayload, buildValidationSummary
 */

const {
  DEFAULT_PANEL,
  sanitizeText,
  sanitizeUrl,
  parseEmbedColor,
  normalizePanelInput,
  buildOAuthUrl,
  buildEmbed,
  buildPanelPayload,
  buildValidationSummary,
} = require('../utils/panelBuilder');

const WHITE_EMBED_COLOR   = 0xffffff; // 16777215
const RED_EMBED_COLOR     = 0xff0000; // 16711680
const DEFAULT_EMBED_COLOR = 0x5865f2; // 5793266

// ---------------------------------------------------------------------------
// sanitizeText
// ---------------------------------------------------------------------------
describe('sanitizeText', () => {
  test('trims whitespace', () => {
    expect(sanitizeText('  hello  ')).toBe('hello');
  });

  test('converts non-string to string', () => {
    expect(sanitizeText(42)).toBe('42');
  });

  test('returns empty string for null/undefined', () => {
    expect(sanitizeText(null)).toBe('');
    expect(sanitizeText(undefined)).toBe('');
  });

  test('truncates at default max (2000)', () => {
    const long = 'a'.repeat(3000);
    expect(sanitizeText(long)).toHaveLength(2000);
  });

  test('truncates at custom max', () => {
    expect(sanitizeText('abcde', 3)).toBe('abc');
  });
});

// ---------------------------------------------------------------------------
// sanitizeUrl
// ---------------------------------------------------------------------------
describe('sanitizeUrl', () => {
  test('returns empty string for empty input', () => {
    expect(sanitizeUrl('')).toBe('');
    expect(sanitizeUrl(null)).toBe('');
    expect(sanitizeUrl(undefined)).toBe('');
  });

  test('accepts valid http URL', () => {
    expect(sanitizeUrl('http://example.com')).toBe('http://example.com/');
  });

  test('accepts valid https URL', () => {
    expect(sanitizeUrl('https://example.com/path')).toBe('https://example.com/path');
  });

  test('rejects non-http/https protocol', () => {
    expect(sanitizeUrl('ftp://example.com')).toBe('');
    expect(sanitizeUrl('javascript:alert(1)')).toBe('');
  });

  test('rejects malformed URL', () => {
    expect(sanitizeUrl('not a url')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// parseEmbedColor
// ---------------------------------------------------------------------------
describe('parseEmbedColor', () => {
  const DEFAULT_COLOR = DEFAULT_EMBED_COLOR;

  test('parses #rrggbb hex string', () => {
    expect(parseEmbedColor('#ffffff')).toBe(WHITE_EMBED_COLOR);
  });

  test('parses rrggbb hex string without hash', () => {
    expect(parseEmbedColor('ff0000')).toBe(RED_EMBED_COLOR);
  });

  test('parses decimal string', () => {
    expect(parseEmbedColor('255')).toBe(255);
  });

  test('returns default for invalid value', () => {
    expect(parseEmbedColor('not-a-color')).toBe(DEFAULT_COLOR);
    expect(parseEmbedColor('')).toBe(DEFAULT_COLOR);
    expect(parseEmbedColor(null)).toBe(DEFAULT_COLOR);
  });

  test('returns default for out-of-range decimal', () => {
    expect(parseEmbedColor('16777216')).toBe(DEFAULT_COLOR);
    expect(parseEmbedColor('-1')).toBe(DEFAULT_COLOR);
  });

  test('parses case-insensitive hex', () => {
    expect(parseEmbedColor('#FFFFFF')).toBe(WHITE_EMBED_COLOR);
    expect(parseEmbedColor('#ffffff')).toBe(WHITE_EMBED_COLOR);
  });

  test('parses zero as black', () => {
    expect(parseEmbedColor('0')).toBe(0);
  });

  test('parses max valid decimal', () => {
    expect(parseEmbedColor('16777215')).toBe(WHITE_EMBED_COLOR);
  });
});

// ---------------------------------------------------------------------------
// normalizePanelInput
// ---------------------------------------------------------------------------
describe('normalizePanelInput', () => {
  test('returns defaults for empty object', () => {
    const result = normalizePanelInput({});
    expect(result.title).toBe(DEFAULT_PANEL.title);
    expect(result.description).toBe(DEFAULT_PANEL.description);
    expect(result.verifyType).toBe('oauth');
    expect(result.showTimestamp).toBe(false);
  });

  test('overrides default title', () => {
    const result = normalizePanelInput({ title: 'Custom Title' });
    expect(result.title).toBe('Custom Title');
  });

  test('falls back to default title when title is empty', () => {
    const result = normalizePanelInput({ title: '' });
    expect(result.title).toBe(DEFAULT_PANEL.title);
  });

  test('sanitizes imageUrl from imageUrl field', () => {
    const result = normalizePanelInput({ imageUrl: 'https://example.com/img.png' });
    expect(result.imageUrl).toBe('https://example.com/img.png');
  });

  test('falls back imageUrl to image field', () => {
    const result = normalizePanelInput({ image: 'https://example.com/img.png' });
    expect(result.imageUrl).toBe('https://example.com/img.png');
  });

  test('rejects invalid imageUrl', () => {
    const result = normalizePanelInput({ imageUrl: 'not-a-url' });
    expect(result.imageUrl).toBe('');
  });

  test('normalizes verifyType via normalizeVerifyMode', () => {
    const result = normalizePanelInput({ verifyType: 'direct' });
    expect(result.verifyType).toBe('direct');
  });

  test('showTimestamp is coerced to boolean', () => {
    expect(normalizePanelInput({ showTimestamp: 1 }).showTimestamp).toBe(true);
    expect(normalizePanelInput({ showTimestamp: 0 }).showTimestamp).toBe(false);
  });

  test('buttonText falls back to buttonLabel', () => {
    const result = normalizePanelInput({ buttonText: '', buttonLabel: 'Click Me' });
    expect(result.buttonText).toBe('Click Me');
    expect(result.buttonLabel).toBe('Click Me');
  });
});

// ---------------------------------------------------------------------------
// buildOAuthUrl
// ---------------------------------------------------------------------------
describe('buildOAuthUrl', () => {
  test('builds correct URL', () => {
    const url = buildOAuthUrl({ baseUrl: 'https://bot.example.com', state: 'abc123' });
    expect(url).toBe('https://bot.example.com/auth/discord?state=abc123');
  });

  test('strips trailing slash from baseUrl', () => {
    const url = buildOAuthUrl({ baseUrl: 'https://bot.example.com/', state: 'abc' });
    expect(url).toBe('https://bot.example.com/auth/discord?state=abc');
  });

  test('strips multiple trailing slashes', () => {
    const url = buildOAuthUrl({ baseUrl: 'https://bot.example.com///', state: 'abc' });
    expect(url).toBe('https://bot.example.com/auth/discord?state=abc');
  });

  test('returns empty string when baseUrl is missing', () => {
    expect(buildOAuthUrl({ state: 'abc' })).toBe('');
  });

  test('returns empty string when state is missing', () => {
    expect(buildOAuthUrl({ baseUrl: 'https://bot.example.com' })).toBe('');
  });

  test('URL-encodes state', () => {
    const url = buildOAuthUrl({ baseUrl: 'https://bot.example.com', state: 'a b&c' });
    expect(url).toContain('a%20b%26c');
  });
});

// ---------------------------------------------------------------------------
// buildEmbed
// ---------------------------------------------------------------------------
describe('buildEmbed', () => {
  const basePanel = {
    title: 'Test Title',
    description: 'Test Desc',
    color: '#ffffff',
    titleUrl: '',
    imageUrl: '',
    thumbnailUrl: '',
    footerText: '',
    showTimestamp: false,
  };

  test('includes title and description', () => {
    const embed = buildEmbed(basePanel);
    expect(embed.title).toBe('Test Title');
    expect(embed.description).toBe('Test Desc');
  });

  test('converts color hex string to integer', () => {
    const embed = buildEmbed({ ...basePanel, color: '#ffffff' });
    expect(embed.color).toBe(WHITE_EMBED_COLOR);
  });

  test('omits url when titleUrl is empty', () => {
    const embed = buildEmbed({ ...basePanel, titleUrl: '' });
    expect(embed.url).toBeUndefined();
  });

  test('includes url when titleUrl is set', () => {
    const embed = buildEmbed({ ...basePanel, titleUrl: 'https://example.com' });
    expect(embed.url).toBe('https://example.com');
  });

  test('includes image when imageUrl is set', () => {
    const embed = buildEmbed({ ...basePanel, imageUrl: 'https://example.com/img.png' });
    expect(embed.image).toEqual({ url: 'https://example.com/img.png' });
  });

  test('omits image when imageUrl is empty', () => {
    const embed = buildEmbed({ ...basePanel, imageUrl: '' });
    expect(embed.image).toBeUndefined();
  });

  test('includes thumbnail when thumbnailUrl is set', () => {
    const embed = buildEmbed({ ...basePanel, thumbnailUrl: 'https://example.com/t.png' });
    expect(embed.thumbnail).toEqual({ url: 'https://example.com/t.png' });
  });

  test('includes footer when footerText is set', () => {
    const embed = buildEmbed({ ...basePanel, footerText: 'Footer' });
    expect(embed.footer).toEqual({ text: 'Footer' });
  });

  test('omits footer when footerText is empty', () => {
    const embed = buildEmbed({ ...basePanel, footerText: '' });
    expect(embed.footer).toBeUndefined();
  });

  test('includes timestamp when showTimestamp is true', () => {
    const embed = buildEmbed({ ...basePanel, showTimestamp: true });
    expect(embed.timestamp).toBeDefined();
    expect(new Date(embed.timestamp).toString()).not.toBe('Invalid Date');
  });

  test('omits timestamp when showTimestamp is false', () => {
    const embed = buildEmbed({ ...basePanel, showTimestamp: false });
    expect(embed.timestamp).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildPanelPayload
// ---------------------------------------------------------------------------
describe('buildPanelPayload', () => {
  test('returns payload structure with embeds and components', () => {
    const payload = buildPanelPayload({
      panel: { verifyType: 'oauth' },
      oauthUrl: 'https://bot.example.com/auth/discord?state=xyz',
    });
    expect(payload).toHaveProperty('embeds');
    expect(payload.embeds).toHaveLength(1);
    expect(payload).toHaveProperty('components');
    expect(payload.components).toHaveLength(1);
    expect(payload.components[0].type).toBe(1);
  });

  test('returns allowed_mentions default', () => {
    const payload = buildPanelPayload({ panel: {} });
    expect(payload.allowed_mentions).toEqual({ parse: [] });
  });

  test('oauth mode with valid url produces link button (style 5)', () => {
    const payload = buildPanelPayload({
      panel: { verifyType: 'oauth' },
      oauthUrl: 'https://bot.example.com/auth/discord?state=xyz',
    });
    const button = payload.components[0].components[0];
    expect(button.style).toBe(5);
    expect(button.url).toContain('https://');
  });

  test('oauth mode without url produces disabled button', () => {
    const payload = buildPanelPayload({
      panel: { verifyType: 'oauth' },
      oauthUrl: '',
    });
    const button = payload.components[0].components[0];
    expect(button.disabled).toBe(true);
  });

  test('direct mode produces custom_id button (style 3)', () => {
    const payload = buildPanelPayload({
      panel: { verifyType: 'direct' },
      directCustomId: 'verify_btn',
    });
    const button = payload.components[0].components[0];
    expect(button.style).toBe(3);
    expect(button.custom_id).toBe('verify_btn');
  });

  test('embed color for red panel is correct decimal', () => {
    const payload = buildPanelPayload({ panel: { color: '#ff0000' } });
    expect(payload.embeds[0].color).toBe(RED_EMBED_COLOR);
  });
});

// ---------------------------------------------------------------------------
// buildValidationSummary
// ---------------------------------------------------------------------------
describe('buildValidationSummary', () => {
  test('ok=true when no errors and all checks pass', () => {
    const result = buildValidationSummary({ ok: true, checks: [] });
    expect(result.ok).toBe(true);
  });

  test('ok=false when errors array is non-empty', () => {
    const result = buildValidationSummary({ ok: true, errors: ['missing field'] });
    expect(result.ok).toBe(false);
  });

  test('ok=false when any check has ok=false', () => {
    const result = buildValidationSummary({
      ok: true,
      checks: [{ ok: false, label: 'title' }],
    });
    expect(result.ok).toBe(false);
  });

  test('ok=false when top-level ok is false', () => {
    const result = buildValidationSummary({ ok: false, checks: [] });
    expect(result.ok).toBe(false);
  });

  test('includes checks, warnings and errors in result', () => {
    const result = buildValidationSummary({
      ok: true,
      checks: [{ ok: true }],
      warnings: ['w1'],
      errors: [],
    });
    expect(result.checks).toHaveLength(1);
    expect(result.warnings).toEqual(['w1']);
    expect(result.errors).toEqual([]);
  });

  test('defaults checks/warnings/errors to empty arrays', () => {
    const result = buildValidationSummary({ ok: true });
    expect(result.checks).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});
