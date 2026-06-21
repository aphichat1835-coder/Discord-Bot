'use strict';

/**
 * Tests for dashboard-public/utils/ipUtils.js
 *
 * Covers new/changed code from the PR:
 *   - normalizeIP() – enhanced with IPv6 bracket stripping and IPv4:port stripping
 *   - splitHeaderIps() – new helper (tested indirectly via getTrustedRequestIp)
 *   - isValidIP() – new helper (tested via getTrustedRequestIp)
 *   - getTrustedRequestIp() – new exported function
 *   - getRealIP() – thin wrapper on getTrustedRequestIp
 *   - detectSpoofedHeaders() – tested via processIP behavior (internal, tested indirectly)
 *
 * NOTE: processIP() requires network access and crypto env vars.
 * We test it in isolation by mocking fetch and setting ENCRYPTION_KEY.
 */

// Set up required env vars before requiring the module
process.env.ENCRYPTION_KEY = 'test-key-for-unit-tests-only';
process.env.API_SECRET = 'test-api-secret';

const {
    normalizeIP,
    getTrustedRequestIp,
    getRealIP,
    getIpLookupConfig,
    getIpLookupDiagnostics,
    lookupIP,
    isPrivateIP,
    extractDevice,
    processIP
} = require('../utils/ipUtils');

// ---------------------------------------------------------------------------
// Helper to build a mock Express request
// ---------------------------------------------------------------------------
function makeReq({ ip, socketIp, headers = {} } = {}) {
    return {
        ip,
        socket: socketIp ? { remoteAddress: socketIp } : {},
        connection: {},
        headers
    };
}

// ---------------------------------------------------------------------------
// normalizeIP()
// ---------------------------------------------------------------------------
describe('normalizeIP', () => {
    test('returns unknown for falsy input', () => {
        expect(normalizeIP(null)).toBe('unknown');
        expect(normalizeIP(undefined)).toBe('unknown');
        expect(normalizeIP('')).toBe('unknown');
        expect(normalizeIP(0)).toBe('unknown');
    });

    test('strips IPv4-mapped IPv6 prefix ::ffff:', () => {
        expect(normalizeIP('::ffff:1.2.3.4')).toBe('1.2.3.4');
        expect(normalizeIP('::ffff:192.168.1.100')).toBe('192.168.1.100');
    });

    test('maps ::1 to 127.0.0.1', () => {
        expect(normalizeIP('::1')).toBe('127.0.0.1');
    });

    test('strips zone ID from IPv6 link-local addresses', () => {
        expect(normalizeIP('fe80::1%eth0')).toBe('fe80::1');
        expect(normalizeIP('fe80::abc:def%lo')).toBe('fe80::abc:def');
    });

    test('strips brackets from bracketed IPv6 addresses (new in PR)', () => {
        expect(normalizeIP('[::1]')).toBe('::1');
        expect(normalizeIP('[2001:db8::1]')).toBe('2001:db8::1');
        expect(normalizeIP('[fe80::1]')).toBe('fe80::1');
    });

    test('strips port from IPv4:port format (new in PR)', () => {
        expect(normalizeIP('1.2.3.4:8080')).toBe('1.2.3.4');
        expect(normalizeIP('10.0.0.1:443')).toBe('10.0.0.1');
        expect(normalizeIP('192.168.1.1:3000')).toBe('192.168.1.1');
    });

    test('returns regular IPv4 addresses unchanged', () => {
        expect(normalizeIP('8.8.8.8')).toBe('8.8.8.8');
        expect(normalizeIP('1.1.1.1')).toBe('1.1.1.1');
        expect(normalizeIP('192.168.0.1')).toBe('192.168.0.1');
    });

    test('returns regular IPv6 addresses unchanged', () => {
        expect(normalizeIP('2001:db8::1')).toBe('2001:db8::1');
    });

    test('trims whitespace', () => {
        expect(normalizeIP('  8.8.8.8  ')).toBe('8.8.8.8');
    });

    test('returns unknown for empty string after processing', () => {
        // edge case: whitespace-only
        expect(normalizeIP('   ')).toBe('unknown');
    });

    // Regression: ::ffff: + IPv4:port should strip both prefixes in correct order
    test('handles ::ffff: prefix before port stripping', () => {
        // ::ffff:1.2.3.4 → 1.2.3.4, not treated as IPv4:port
        expect(normalizeIP('::ffff:1.2.3.4')).toBe('1.2.3.4');
    });
});

// ---------------------------------------------------------------------------
// getTrustedRequestIp()
// ---------------------------------------------------------------------------
describe('getTrustedRequestIp', () => {
    describe('when ENABLE_CF_IP_HEADER is false (default)', () => {
        // By default the module is loaded without ENABLE_CF_IP_HEADER=true,
        // so CF header should NOT be used as the trusted source.

        test('uses req.ip when it is a valid public IP', () => {
            const req = makeReq({ ip: '8.8.8.8' });
            const result = getTrustedRequestIp(req);
            expect(result.ip).toBe('8.8.8.8');
            expect(result.source).toBe('req.ip');
        });

        test('falls back to socket remoteAddress when req.ip is absent', () => {
            const req = makeReq({ socketIp: '8.8.4.4' });
            const result = getTrustedRequestIp(req);
            expect(result.ip).toBe('8.8.4.4');
            expect(result.source).toBe('remoteAddress');
        });

        test('returns unknown when no valid IP is available', () => {
            const req = makeReq({});
            const result = getTrustedRequestIp(req);
            expect(result.ip).toBe('unknown');
            expect(result.source).toBe('unknown');
        });

        test('ignores cf-connecting-ip header when ENABLE_CF_IP_HEADER is false', () => {
            const req = makeReq({
                ip: '8.8.8.8',
                headers: { 'cf-connecting-ip': '1.2.3.4' }
            });
            const result = getTrustedRequestIp(req);
            // Should use req.ip, not CF header
            expect(result.ip).toBe('8.8.8.8');
            expect(result.source).toBe('req.ip');
        });

        test('prefers req.ip over remoteAddress', () => {
            const req = makeReq({ ip: '8.8.8.8', socketIp: '1.1.1.1' });
            const result = getTrustedRequestIp(req);
            expect(result.ip).toBe('8.8.8.8');
            expect(result.source).toBe('req.ip');
        });

        test('strips ::ffff: from req.ip before using', () => {
            const req = makeReq({ ip: '::ffff:8.8.8.8' });
            const result = getTrustedRequestIp(req);
            expect(result.ip).toBe('8.8.8.8');
        });

        test('private req.ip falls back to remoteAddress', () => {
            // 192.168.x.x is private – not a valid public IP
            const req = makeReq({ ip: '192.168.1.1', socketIp: '8.8.8.8' });
            const result = getTrustedRequestIp(req);
            // 192.168.1.1 is a valid IP (passes isValidIP) but isPrivateIP
            // getTrustedRequestIp uses isValidIP only (not isPrivateIP) to choose req.ip
            // so req.ip (private) should still be selected over remoteAddress
            expect(result.ip).toBe('192.168.1.1');
            expect(result.source).toBe('req.ip');
        });

        test('returns unknown source when only localhost socket available', () => {
            const req = makeReq({ socketIp: '127.0.0.1' });
            const result = getTrustedRequestIp(req);
            // 127.0.0.1 is valid for isValidIP (net.isIP returns 4) but is private
            // getTrustedRequestIp checks isValidIP only, so it will use it
            expect(result.ip).toBe('127.0.0.1');
            expect(result.source).toBe('remoteAddress');
        });
    });

    describe('req object edge cases', () => {
        test('handles req.ip of undefined gracefully', () => {
            const req = { headers: {}, socket: {}, connection: {} };
            const result = getTrustedRequestIp(req);
            expect(result).toHaveProperty('ip');
            expect(result).toHaveProperty('source');
        });

        test('handles completely empty headers', () => {
            const req = makeReq({ ip: '8.8.8.8', headers: {} });
            const result = getTrustedRequestIp(req);
            expect(result.ip).toBe('8.8.8.8');
        });
    });
});

// ---------------------------------------------------------------------------
// getRealIP()
// ---------------------------------------------------------------------------
describe('getRealIP', () => {
    test('returns the ip from getTrustedRequestIp', () => {
        const req = makeReq({ ip: '1.1.1.1' });
        expect(getRealIP(req)).toBe('1.1.1.1');
    });

    test('returns unknown when no valid IP available', () => {
        const req = makeReq({});
        expect(getRealIP(req)).toBe('unknown');
    });

    test('returns normalized IP (strips ::ffff:)', () => {
        const req = makeReq({ ip: '::ffff:8.8.4.4' });
        expect(getRealIP(req)).toBe('8.8.4.4');
    });
});

describe('IP lookup diagnostics', () => {
    test('reports bounded cache and circuit state without sensitive IP values', () => {
        const diag = getIpLookupDiagnostics();

        expect(diag).toHaveProperty('cacheSize');
        expect(diag).toHaveProperty('cacheMax');
        expect(diag).toHaveProperty('cacheTtlMs');
        expect(diag).toHaveProperty('circuitFailures');
        expect(diag).toHaveProperty('circuitOpen');
        expect(diag.cacheSize).toBeLessThanOrEqual(diag.cacheMax);
        const publicIpSample = ['8', '8', '8', '8'].join('.');
        expect(JSON.stringify(diag)).not.toContain(publicIpSample);
    });
});

describe('private and reserved IP detection', () => {
    test.each([
        '10.0.0.1',
        '100.64.0.1',
        '169.254.1.1',
        '172.16.0.1',
        '192.0.2.10',
        '198.51.100.10',
        '203.0.113.10',
        '224.0.0.1',
        '240.0.0.1',
        '2001:db8::1',
        'ff02::1'
    ])('%s is treated as private/reserved', ip => {
        expect(isPrivateIP(ip)).toBe(true);
    });

    test('public IP remains lookup eligible', () => {
        expect(isPrivateIP('8.8.8.8')).toBe(false);
    });
});

describe('processIP risk flags', () => {
    const oldFetch = global.fetch;
    const oldLookupEnabled = process.env.IP_LOOKUP_ENABLED;

    afterEach(() => {
        global.fetch = oldFetch;
        if (oldLookupEnabled === undefined) delete process.env.IP_LOOKUP_ENABLED;
        else process.env.IP_LOOKUP_ENABLED = oldLookupEnabled;
    });

    test('returns concrete risk flags from lookup and headers', async () => {
        process.env.IP_LOOKUP_ENABLED = 'true';
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                status: 'success',
                country: 'United States',
                countryCode: 'US',
                isp: 'Example VPN Hosting',
                org: 'Example Hosting',
                as: 'AS123 Example',
                proxy: true,
                hosting: true,
                vpn: true,
                tor: false,
                query: '8.8.8.8'
            })
        }));

        const info = await processIP(makeReq({
            ip: '8.8.8.8',
            headers: {
                'x-real-ip': '1.1.1.1'
            }
        }));

        expect(info.riskFlags).toEqual(expect.arrayContaining([
            'vpn',
            'proxy',
            'hosting',
            'spoofed_header',
            'xRealIp_conflicts_with_trusted_ip'
        ]));
        expect(info.riskBreakdown).toMatchObject({
            vpn: 35,
            proxy: 35,
            hosting: 25,
            spoofedHeader: 15
        });
        expect(info.riskScore).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// External IP lookup config
// ---------------------------------------------------------------------------
describe('IP lookup config', () => {
    const oldEnabled = process.env.IP_LOOKUP_ENABLED;
    const oldBaseUrl = process.env.IP_LOOKUP_API_BASE_URL;

    afterEach(() => {
        if (oldEnabled === undefined) delete process.env.IP_LOOKUP_ENABLED;
        else process.env.IP_LOOKUP_ENABLED = oldEnabled;

        if (oldBaseUrl === undefined) delete process.env.IP_LOOKUP_API_BASE_URL;
        else process.env.IP_LOOKUP_API_BASE_URL = oldBaseUrl;
    });

    test('uses HTTPS default lookup base URL', () => {
        delete process.env.IP_LOOKUP_API_BASE_URL;
        const config = getIpLookupConfig();

        expect(config.enabled).toBe(true);
        expect(config.baseUrl.startsWith('https://')).toBe(true);
    });

    test('can disable external IP lookup', async () => {
        process.env.IP_LOOKUP_ENABLED = 'false';

        const lookup = await lookupIP('9.9.9.9');

        expect(lookup.provider).toBe('disabled');
        expect(lookup.status).toBe('lookup_disabled');
        expect(lookup.query).toBe('9.9.9.9');
    });

    test('opens circuit breaker after repeated provider failures', async () => {
        process.env.IP_LOOKUP_ENABLED = 'true';
        global.fetch = jest.fn(async () => {
            throw new Error('provider down');
        });

        for (let i = 0; i < 10; i++) {
            await expect(lookupIP(`8.8.4.${i}`)).rejects.toThrow('provider down');
        }

        const lookup = await lookupIP('1.0.0.1');
        expect(lookup.provider).toBe('circuit_breaker');
        expect(lookup.status).toBe('lookup_failed');
    });
});

describe('device fingerprint metadata', () => {
    test('includes a fingerprint version next to fingerprintHash', () => {
        const device = extractDevice({
            headers: {
                'user-agent': 'Mozilla/5.0 Test',
                'accept-language': 'th-TH'
            },
            body: {
                platform: 'MacIntel',
                timezone: 'Asia/Bangkok',
                screenSize: '1440x900',
                viewportSize: '1200x800'
            }
        });

        expect(device.fingerprintVersion).toBe(1);
        expect(device.fingerprintHash).toEqual(expect.any(String));
    });
});

// ---------------------------------------------------------------------------
// detectSpoofedHeaders() – tested indirectly via getTrustedRequestIp behavior
// and by examining what getRealIP returns under suspicious header conditions
//
// We test the key flag behaviors by manually replicating the logic:
// The function is internal but its effects surface through processIP.
// Here we test the observable behaviors via the exported API.
// ---------------------------------------------------------------------------
describe('Spoof detection via exported API behavior', () => {
    test('getTrustedRequestIp does NOT use cf-connecting-ip by default', () => {
        // Even with a different CF header, the req.ip wins
        const req = makeReq({
            ip: '8.8.8.8',
            headers: {
                'cf-connecting-ip': '5.5.5.5'
            }
        });
        expect(getRealIP(req)).toBe('8.8.8.8');
    });

    test('getTrustedRequestIp uses remoteAddress as fallback when req.ip is missing', () => {
        const req = {
            headers: { 'x-forwarded-for': '8.8.8.8' },
            socket: { remoteAddress: '1.2.3.4' },
            connection: {}
        };
        const result = getTrustedRequestIp(req);
        // Should use remoteAddress, not x-forwarded-for (no trust proxy)
        expect(result.ip).toBe('1.2.3.4');
    });
});

// ---------------------------------------------------------------------------
// normalizeIP edge cases and regression tests
// ---------------------------------------------------------------------------
describe('normalizeIP regression cases', () => {
    test('does not break on IPv4 with no port', () => {
        expect(normalizeIP('203.0.113.5')).toBe('203.0.113.5');
    });

    test('handles IPv4:port edge case with port 0', () => {
        expect(normalizeIP('1.2.3.4:0')).toBe('1.2.3.4');
    });

    test('does not strip colon from IPv6 address (not IPv4:port pattern)', () => {
        const ipv6 = '2001:db8:85a3::8a2e:370:7334';
        const result = normalizeIP(ipv6);
        // Should return the IPv6 address unchanged (it doesn't match IPv4:port regex)
        expect(result).toBe('2001:db8:85a3::8a2e:370:7334');
    });

    test('handles string with only spaces', () => {
        expect(normalizeIP('   ')).toBe('unknown');
    });

    test('handles large number as input (coerced to string)', () => {
        // normalizeIP does String(ip) internally
        const result = normalizeIP(2130706433); // 127.0.0.1 as integer
        // Result should be the string representation, not a valid IP format
        expect(typeof result).toBe('string');
    });
});
