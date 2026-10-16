const nodeTest = require('node:test');
const describe = globalThis.describe || nodeTest.describe;
const test = globalThis.test || globalThis.it || nodeTest.it || nodeTest.test;
const expect = globalThis.expect || require('expect').expect || require('expect');

const discordAPI = require('../discord/verification/utils/discordAPI');
const {
    normalizeRequestBody,
    validateRequestBodySize,
    prepareDiscordRequestHeaders,
    DISCORD_API_BODY_MAX_BYTES
} = discordAPI._test;

describe('Discord API normalizeRequestBody contract', () => {
    test('returns null for null and undefined inputs', () => {
        expect(normalizeRequestBody(null)).toBeNull();
        expect(normalizeRequestBody(undefined)).toBeNull();
    });

    test('returns empty Buffer for empty string', () => {
        const result = normalizeRequestBody('');
        expect(Buffer.isBuffer(result)).toBe(true);
        expect(result.length).toBe(0);
        expect(result.equals(Buffer.alloc(0))).toBe(true);
    });

    test('returns Buffer with matching UTF-8 bytes for string input', () => {
        const testString = 'Hello Discord! สวัสดีชาวโลก 🚀';
        const expectedBuffer = Buffer.from(testString, 'utf8');

        const result = normalizeRequestBody(testString);
        expect(Buffer.isBuffer(result)).toBe(true);
        expect(result.length).toBe(expectedBuffer.length);
        expect(result.equals(expectedBuffer)).toBe(true);
        expect(result.toString('utf8')).toBe(testString);
    });

    test('returns original Buffer instance and preserves exact binary bytes', () => {
        const binaryBuffer = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x12, 0x34, 0x56, 0x78]);

        const result = normalizeRequestBody(binaryBuffer);
        expect(Buffer.isBuffer(result)).toBe(true);
        expect(result).toBe(binaryBuffer);
        expect(result.equals(binaryBuffer)).toBe(true);
    });

    test('returns Buffer of query string when input is URLSearchParams', () => {
        const params = new URLSearchParams({
            client_id: '123456789012345678',
            grant_type: 'authorization_code',
            code: 'xyz_sample_oauth_code'
        });
        const expectedString = params.toString();
        const expectedBuffer = Buffer.from(expectedString, 'utf8');

        const result = normalizeRequestBody(params);
        expect(Buffer.isBuffer(result)).toBe(true);
        expect(result.equals(expectedBuffer)).toBe(true);
        expect(result.toString('utf8')).toBe(expectedString);
    });

    test('returns Buffer for generic object with custom toString', () => {
        const customPayload = {
            id: '1001',
            action: 'verify',
            toString() {
                return JSON.stringify({ id: this.id, action: this.action });
            }
        };
        const expectedString = customPayload.toString();
        const expectedBuffer = Buffer.from(expectedString, 'utf8');

        const result = normalizeRequestBody(customPayload);
        expect(Buffer.isBuffer(result)).toBe(true);
        expect(result.equals(expectedBuffer)).toBe(true);
        expect(result.toString('utf8')).toBe(expectedString);
    });

    test('returns Buffer for numeric inputs', () => {
        const result = normalizeRequestBody(12345);
        expect(Buffer.isBuffer(result)).toBe(true);
        expect(result.toString('utf8')).toBe('12345');
    });
});

describe('Discord API validateRequestBodySize', () => {
    test('passes when body is null or within size limit', () => {
        expect(() => validateRequestBodySize(null)).not.toThrow();
        expect(() => validateRequestBodySize(Buffer.from('small payload'))).not.toThrow();
        expect(() => validateRequestBodySize(Buffer.alloc(DISCORD_API_BODY_MAX_BYTES))).not.toThrow();
    });

    test('throws discord_request_body_too_large error with retryable: false when body exceeds limit', () => {
        const initialTooLargeCount = discordAPI.getDiscordApiDiagnostics().requestBodyTooLarge;
        const oversized = Buffer.alloc(DISCORD_API_BODY_MAX_BYTES + 1);

        let thrownError = null;
        try {
            validateRequestBodySize(oversized);
        } catch (err) {
            thrownError = err;
        }

        expect(thrownError).toBeInstanceOf(Error);
        expect(thrownError.code).toBe('discord_request_body_too_large');
        expect(thrownError.retryable).toBe(false);
        expect(thrownError.message).toContain('Discord API request body too large');
        expect(thrownError.message).toContain(`${DISCORD_API_BODY_MAX_BYTES + 1} bytes`);

        const updatedCount = discordAPI.getDiscordApiDiagnostics().requestBodyTooLarge;
        expect(updatedCount).toBe(initialTooLargeCount + 1);
    });
});

describe('Discord API prepareDiscordRequestHeaders', () => {
    test('sets Content-Length matching actual byte length when body is Buffer', () => {
        const bodyAscii = Buffer.from('hello world', 'utf8');
        const headersAscii = prepareDiscordRequestHeaders({ 'Authorization': 'Bot sample_token' }, bodyAscii);

        expect(headersAscii['Content-Length']).toBe(11);
        expect(headersAscii['Authorization']).toBe('Bot sample_token');

        const multiByteString = 'สวัสดี Discord API 🚀';
        const bodyUtf8 = Buffer.from(multiByteString, 'utf8');
        const headersUtf8 = prepareDiscordRequestHeaders({}, bodyUtf8);

        expect(headersUtf8['Content-Length']).toBe(bodyUtf8.length);
        expect(headersUtf8['Content-Length']).toBeGreaterThan(multiByteString.length);
    });

    test('does not set Content-Length when body is null or undefined', () => {
        const headersNull = prepareDiscordRequestHeaders({ 'Authorization': 'Bot sample_token' }, null);
        expect(headersNull['Content-Length']).toBeUndefined();
        expect(headersNull['content-length']).toBeUndefined();
        expect(headersNull['Authorization']).toBe('Bot sample_token');

        const headersUndefined = prepareDiscordRequestHeaders({ 'Accept': 'application/json' });
        expect(headersUndefined['Content-Length']).toBeUndefined();
        expect(headersUndefined['content-length']).toBeUndefined();
        expect(headersUndefined['Accept']).toBe('application/json');
    });

    test('preserves existing Content-Length header if already provided', () => {
        const body = Buffer.from('payload');
        const headersUpper = prepareDiscordRequestHeaders({ 'Content-Length': 999 }, body);
        expect(headersUpper['Content-Length']).toBe(999);

        const headersLower = prepareDiscordRequestHeaders({ 'content-length': 888 }, body);
        expect(headersLower['content-length']).toBe(888);
        expect(headersLower['Content-Length']).toBeUndefined();
    });
});
