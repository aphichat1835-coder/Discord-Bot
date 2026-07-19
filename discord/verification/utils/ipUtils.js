/* eslint-disable complexity -- IP normalization helpers are behavior-sensitive; refactor separately. */
const net = require('net');
const { encryptIP, hmacValue } = require('./crypto');

const ENABLE_CF_IP_HEADER = String(process.env.ENABLE_CF_IP_HEADER || '').toLowerCase() === 'true';
const TRUST_PROXY_FOR_CF_HEADER = String(process.env.TRUST_PROXY || '').toLowerCase() === 'true';
const IP_LOOKUP_TIMEOUT_MS = Math.max(1000, Number(process.env.IP_LOOKUP_TIMEOUT_MS || 3500) || 3500);
const IP_LOOKUP_RETRIES = Math.max(1, Math.min(3, Number(process.env.IP_LOOKUP_RETRIES || 2) || 2));
const IP_LOOKUP_CACHE_TTL_MS = Math.max(60 * 1000, Number(process.env.IP_LOOKUP_CACHE_TTL_MS || 10 * 60 * 1000) || 10 * 60 * 1000);
const IP_LOOKUP_CACHE_MAX = Math.max(100, Number(process.env.IP_LOOKUP_CACHE_MAX || 5000) || 5000);
const IP_LOOKUP_CIRCUIT_FAIL_THRESHOLD = Math.max(1, Number(process.env.IP_LOOKUP_CIRCUIT_FAIL_THRESHOLD || 10) || 10);
const IP_LOOKUP_CIRCUIT_OPEN_MS = Math.max(10000, Number(process.env.IP_LOOKUP_CIRCUIT_OPEN_MS || 5 * 60 * 1000) || 5 * 60 * 1000);
const DEFAULT_IP_LOOKUP_RESPONSE_MAX_BYTES = 256 * 1024;
function resolveResponseMaxBytes(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_IP_LOOKUP_RESPONSE_MAX_BYTES;
    return Math.max(16 * 1024, Math.floor(parsed));
}
const IP_LOOKUP_RESPONSE_MAX_BYTES = resolveResponseMaxBytes(process.env.IP_LOOKUP_RESPONSE_MAX_BYTES);
const DEVICE_FINGERPRINT_VERSION = 1;
const X_FORWARDED_FOR_MAX_ENTRIES = 20;
const IPV4_MASK_ALL = 2 ** 32 - 1;
const DEFAULT_IP_LOOKUP_API_BASE_URL = 'https://api.ipapi.is';
const DEFAULT_IP_LOOKUP_FALLBACK_URL = 'https://ipapi.co/{ip}/json/';
const lookupCache = new Map();
const lookupCircuit = {
    failures: 0,
    openUntil: 0,
    lastError: null
};

function getIpLookupConfig() {
    const enabledRaw = String(process.env.IP_LOOKUP_ENABLED ?? 'true').trim().toLowerCase();
    const enabled = !['0', 'false', 'no', 'off', 'disabled'].includes(enabledRaw);
    const customBaseUrl = String(process.env.IP_LOOKUP_API_BASE_URL || '').trim();
    const fallbackRaw = String(process.env.IP_LOOKUP_FALLBACK_ENABLED ?? 'true').trim().toLowerCase();
    const fallbackEnabled = !['0', 'false', 'no', 'off', 'disabled'].includes(fallbackRaw);
    const baseUrl = customBaseUrl || DEFAULT_IP_LOOKUP_API_BASE_URL;

    return {
        enabled,
        baseUrl,
        fallbackEnabled,
        providers: [
            customBaseUrl
                ? { name: 'custom', baseUrl: customBaseUrl, type: 'ip-api' }
                : { name: 'ipapi.is', baseUrl: DEFAULT_IP_LOOKUP_API_BASE_URL, type: 'ipapi-is' },
            ...(fallbackEnabled
                ? [{ name: 'ipapi.co', baseUrl: DEFAULT_IP_LOOKUP_FALLBACK_URL, type: 'ipapi-co' }]
                : [])
        ]
    };
}

function trimTrailingSlashes(value) {
    const text = String(value || '');
    let end = text.length;

    while (end > 0 && text[end - 1] === '/') end--;

    return text.slice(0, end);
}

function firstHeaderValue(value) {
    if (!value) return null;
    if (Array.isArray(value)) return value[0] || null;
    return String(value).split(',')[0].trim() || null;
}

function splitHeaderIps(value) {
    if (!value) return [];
    const raw = Array.isArray(value) ? value.join(',') : String(value);
    return raw
        .split(',')
        .map(v => v.trim())
        .filter(Boolean)
        .slice(0, X_FORWARDED_FOR_MAX_ENTRIES);
}

function normalizeIP(ip) {
    if (!ip) return 'unknown';

    let value = String(ip).trim();

    if (value.startsWith('::ffff:')) value = value.slice(7);
    if (value === '::1') value = '127.0.0.1';
    if (value.includes('%')) value = value.split('%')[0];

    if (value.startsWith('[') && value.includes(']')) {
        value = value.slice(1, value.indexOf(']'));
    } else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(value)) {
        value = value.split(':')[0];
    }

    return value || 'unknown';
}

function isValidIP(ip) {
    return !!ip && ip !== 'unknown' && net.isIP(normalizeIP(ip)) !== 0;
}

function getRemoteAddress(req) {
    return normalizeIP(
        req.socket?.remoteAddress ||
        req.connection?.remoteAddress ||
        req.ip ||
        'unknown'
    );
}

function parseHeaderIp(value) {
    const ip = normalizeIP(firstHeaderValue(value));
    return ip && ip !== 'unknown' ? ip : null;
}

function getHeaderIps(req) {
    const xForwardedForValues = splitHeaderIps(req.headers['x-forwarded-for']);
    const xForwardedForFirst = normalizeIP(xForwardedForValues[0] || null);

    return {
        cfConnectingIp: parseHeaderIp(req.headers['cf-connecting-ip']),
        trueClientIp: parseHeaderIp(req.headers['true-client-ip']),
        xRealIp: parseHeaderIp(req.headers['x-real-ip']),
        xClientIp: parseHeaderIp(req.headers['x-client-ip']),
        xForwardedForFirst: xForwardedForFirst !== 'unknown' ? xForwardedForFirst : null,
        xForwardedForChainLength: xForwardedForValues.length,
        xForwardedForChain: xForwardedForValues.map(normalizeIP)
    };
}

function getTrustedRequestIp(req) {
    const reqIp = normalizeIP(req.ip);
    const remoteAddress = getRemoteAddress(req);
    const cfConnectingIp = parseHeaderIp(req.headers['cf-connecting-ip']);

    if (ENABLE_CF_IP_HEADER && TRUST_PROXY_FOR_CF_HEADER && isValidIP(cfConnectingIp) && !isPrivateIP(cfConnectingIp)) {
        return {
            ip: cfConnectingIp,
            source: 'cf-connecting-ip'
        };
    }

    if (isValidIP(reqIp)) {
        return {
            ip: reqIp,
            source: 'req.ip'
        };
    }

    if (isValidIP(remoteAddress)) {
        return {
            ip: remoteAddress,
            source: 'remoteAddress'
        };
    }

    return {
        ip: 'unknown',
        source: 'unknown'
    };
}

function ipv4ToInt(ip) {
    const parts = String(ip || '').split('.').map(v => Number(v));
    if (parts.length !== 4 || parts.some(v => !Number.isInteger(v) || v < 0 || v > 255)) return null;
    return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function isIpv4InCidr(ip, base, bits) {
    const value = ipv4ToInt(ip);
    const baseValue = ipv4ToInt(base);
    if (value === null || baseValue === null) return false;
    const mask = bits === 0 ? 0 : (IPV4_MASK_ALL << (32 - bits)) >>> 0;
    return (value & mask) === (baseValue & mask);
}

function detectSpoofedHeaders(req, trustedIp) {
    const headerIps = getHeaderIps(req);
    const spoofFlags = [];
    const trusted = normalizeIP(trustedIp);
    const comparableTrusted = trusted !== 'unknown' ? trusted : null;

    if (headerIps.cfConnectingIp && !ENABLE_CF_IP_HEADER) {
        spoofFlags.push('cf_header_without_trust');
    }

    if (headerIps.cfConnectingIp && ENABLE_CF_IP_HEADER && !TRUST_PROXY_FOR_CF_HEADER) {
        spoofFlags.push('cf_header_requires_trust_proxy');
    }

    if (headerIps.xForwardedForChainLength > 3) {
        spoofFlags.push('xff_chain_too_long');
    }

    const namedHeaders = [
        ['cf-connecting-ip', headerIps.cfConnectingIp],
        ['true-client-ip', headerIps.trueClientIp],
        ['x-real-ip', headerIps.xRealIp],
        ['x-client-ip', headerIps.xClientIp],
        ['x-forwarded-for', headerIps.xForwardedForFirst]
    ];

    for (const [name, ip] of namedHeaders) {
        if (!ip) continue;
        if (!isValidIP(ip)) spoofFlags.push(`${name}_invalid`);
        if (isValidIP(ip) && isPrivateIP(ip) && comparableTrusted && !isPrivateIP(comparableTrusted)) {
            spoofFlags.push(`${name}_private_ip`);
        }
    }

    for (const ip of headerIps.xForwardedForChain || []) {
        if (!isValidIP(ip)) spoofFlags.push('xff_chain_invalid_ip');
        if (isValidIP(ip) && isPrivateIP(ip) && comparableTrusted && !isPrivateIP(comparableTrusted)) {
            spoofFlags.push('xff_chain_private_ip');
        }
    }

    for (const name of ['xRealIp', 'xClientIp']) {
        const ip = headerIps[name];
        if (ip && comparableTrusted && normalizeIP(ip) !== comparableTrusted) {
            spoofFlags.push(`${name}_conflicts_with_trusted_ip`);
        }
    }

    const publicHeaderIps = namedHeaders
        .map(([, ip]) => normalizeIP(ip))
        .filter(ip => isValidIP(ip) && !isPrivateIP(ip));
    const uniquePublicHeaderIps = Array.from(new Set(publicHeaderIps));
    const headerIpConflict = uniquePublicHeaderIps.length > 1 || uniquePublicHeaderIps.some(ip => comparableTrusted && ip !== comparableTrusted);

    if (headerIpConflict) spoofFlags.push('header_ip_conflict');

    return {
        headerIps: {
            cfConnectingIp: headerIps.cfConnectingIp,
            trueClientIp: headerIps.trueClientIp,
            xRealIp: headerIps.xRealIp,
            xClientIp: headerIps.xClientIp,
            xForwardedForFirst: headerIps.xForwardedForFirst,
            xForwardedForChainLength: headerIps.xForwardedForChainLength
        },
        spoofSuspected: spoofFlags.length > 0,
        spoofFlags: Array.from(new Set(spoofFlags)),
        headerIpConflict
    };
}

function storedHeaderIpMetadata(headerIps = {}) {
    return Object.fromEntries(
        Object.entries(headerIps).map(([key, value]) => {
            if (key.endsWith("Length")) return [key, Number(value || 0)];
            return [
                `${key}Hash`,
                value ? hmacValue(normalizeIP(value), "forwarded_ip") : null
            ];
        })
    );
}

function getRealIP(req) {
    return getTrustedRequestIp(req).ip;
}

function isPrivateIP(ip) {
    const normalized = normalizeIP(ip);
    if (!normalized || normalized === 'unknown') return true;

    const version = net.isIP(normalized);
    if (version === 0) return true;

    if (version === 4) {
        return [
            ['0.0.0.0', 8],
            ['10.0.0.0', 8],
            ['100.64.0.0', 10],
            ['127.0.0.0', 8],
            ['169.254.0.0', 16],
            ['172.16.0.0', 12],
            ['192.0.0.0', 24],
            ['192.0.2.0', 24],
            ['192.168.0.0', 16],
            ['198.18.0.0', 15],
            ['198.51.100.0', 24],
            ['203.0.113.0', 24],
            ['224.0.0.0', 4],
            ['240.0.0.0', 4]
        ].some(([base, bits]) => isIpv4InCidr(normalized, base, bits));
    }

    const lower = normalized.toLowerCase();
    return lower === '::' ||
        lower === '::1' ||
        lower.startsWith('fc') ||
        lower.startsWith('fd') ||
        lower.startsWith('fe80') ||
        lower.startsWith('ff') ||
        lower.startsWith('2001:db8') ||
        lower.startsWith('2002:') ||
        lower.startsWith('64:ff9b:');
}

function parseBrowser(ua) {
    if (/Discord/i.test(ua)) return 'Discord WebView';
    if (/Edg\//i.test(ua)) return 'Edge';
    if (/OPR\//i.test(ua)) return 'Opera';
    if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) return 'Chrome';
    if (/Firefox\//i.test(ua)) return 'Firefox';
    if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) return 'Safari';
    return 'Unknown';
}

function parseOS(ua, platform) {
    const rawPlatform = String(platform || '').trim();

    if (/Android/i.test(ua)) return 'Android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
    if (/Windows/i.test(ua)) return 'Windows';
    if (/CrOS/i.test(ua)) return 'Chrome OS';
    if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';

    if (rawPlatform && rawPlatform !== 'Unknown') {
        if (/iphone|ipad|ipod/i.test(rawPlatform)) return 'iOS';
        if (/android/i.test(rawPlatform)) return 'Android';
        if (/win/i.test(rawPlatform)) return 'Windows';
        if (/mac/i.test(rawPlatform)) return 'macOS';
        if (/linux/i.test(rawPlatform)) return 'Linux';
        return rawPlatform.slice(0, 64);
    }

    if (/Linux/i.test(ua)) return 'Linux';

    return 'Unknown';
}

function normalizedPlatformFamily(value) {
    const text = String(value || '').toLowerCase();
    if (!text) return '';
    if (text.includes('android')) return 'Android';
    if (/iphone|ipad|ios/.test(text)) return 'iOS';
    if (text.includes('win')) return 'Windows';
    if (text.includes('chrome os') || text.includes('cros')) return 'Chrome OS';
    if (text.includes('mac')) return 'macOS';
    if (text.includes('linux')) return 'Linux';
    return '';
}

function detectUserAgentAnomalies({ ua, reportedUa, platform, clientHints, os, deviceType }) {
    const flags = [];
    if (reportedUa && reportedUa !== ua) flags.push('reported_ua_differs_from_header');

    const platformFamily = normalizedPlatformFamily(platform);
    const hintFamily = normalizedPlatformFamily(clientHints?.platform);
    const compatibleIosPlatform = os === 'iOS' && platformFamily === 'macOS';
    if (platformFamily && platformFamily !== os && !compatibleIosPlatform) {
        flags.push('navigator_platform_conflicts_with_user_agent');
    }
    if (hintFamily && hintFamily !== os) flags.push('client_hint_platform_conflicts_with_user_agent');

    if (typeof clientHints?.mobile === 'boolean') {
        const parsedMobile = deviceType === 'mobile' || deviceType === 'tablet';
        if (clientHints.mobile !== parsedMobile) flags.push('client_hint_mobile_conflicts_with_user_agent');
    }
    if (/HeadlessChrome|PhantomJS|Selenium|Playwright|Puppeteer/i.test(ua)) {
        flags.push('automation_user_agent_detected');
    }
    return [...new Set(flags)];
}

function parseDeviceType(ua, body = {}) {
    if (body.touchPoints && Number(body.touchPoints) > 0 && /iPad|Tablet/i.test(ua)) {
        return 'tablet';
    }

    if (/iPad|Tablet/i.test(ua)) return 'tablet';
    if (/Mobile|Android|iPhone|iPod/i.test(ua)) return 'mobile';

    return 'desktop';
}

function safeString(value, fallback = '') {
    if (value === undefined || value === null) return fallback;
    return String(value).replace(/[\u0000-\u001F\u007F]/g, '');
}

function safeSmallString(value, fallback = '') {
    if (value === undefined || value === null) return fallback;
    return safeString(value, fallback).slice(0, 64);
}

function safeBoundedString(value, maxLength, fallback = '') {
    return safeString(value, fallback).slice(0, maxLength);
}

function safeNumber(value, fallback = null) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function safeLanguages(value, fallbackLanguage = '') {
    if (Array.isArray(value)) {
        return value
            .slice(0, 8)
            .map(v => safeSmallString(v, ''))
            .filter(Boolean);
    }

    if (fallbackLanguage) return [fallbackLanguage];

    return [];
}

function extractDevice(req) {
    const ua = safeBoundedString(req.headers['user-agent'] || '', 2048);
    const body = req.body || {};

    const browser = parseBrowser(ua);
    const platform = safeSmallString(body.platform || 'Unknown', 'Unknown');
    const os = parseOS(ua, platform);
    const deviceType = parseDeviceType(ua, body);
    const clientHints = body.clientHints && typeof body.clientHints === 'object' && !Array.isArray(body.clientHints)
        ? {
            brands: Array.isArray(body.clientHints.brands)
                ? body.clientHints.brands.slice(0, 8).map(item => ({
                    brand: safeSmallString(item?.brand || ''),
                    version: safeSmallString(item?.version || '')
                })).filter(item => item.brand)
                : [],
            mobile: body.clientHints.mobile === true,
            platform: safeSmallString(body.clientHints.platform || '')
        }
        : null;
    const userAgentFlags = detectUserAgentAnomalies({
        ua,
        reportedUa: safeBoundedString(body.userAgent || '', 2048),
        platform,
        clientHints,
        os,
        deviceType
    });

    const acceptLanguage = req.headers['accept-language']?.split(',')[0] || '';

    const language = safeSmallString(
        body.language || acceptLanguage || 'unknown',
        'unknown'
    );

    const languages = safeLanguages(body.languages, language);

    const timezone = safeSmallString(body.timezone || 'unknown', 'unknown');
    const screenSize = safeSmallString(body.screenSize || 'unknown', 'unknown');
    const viewportSize = safeSmallString(body.viewportSize || 'unknown', 'unknown');

    const colorDepth = safeNumber(body.colorDepth, null);
    const devicePixelRatio = safeNumber(body.devicePixelRatio, null);
    const touchPoints = safeNumber(body.touchPoints, 0);
    const referrer = safeBoundedString(body.referrer || '', 2048);
    const languagesReportedCount = Math.max(
        languages.length,
        Math.min(1000, Math.max(0, Number(body.languagesReportedCount) || languages.length))
    );

    const fingerprintSource = [
        ua,
        language,
        languages.join(','),
        timezone,
        screenSize,
        viewportSize,
        platform,
        os,
        browser,
        deviceType,
        colorDepth ?? '',
        devicePixelRatio ?? '',
        touchPoints ?? ''
    ].join('|');

    return {
        userAgent: safeString(ua, ''),
        browser,
        os,
        language,
        languages,
        languagesReportedCount,
        languagesTruncated: body.languagesTruncated === true || languagesReportedCount > languages.length,
        timezone,
        platform,
        deviceType,
        screenSize,
        viewportSize,
        colorDepth,
        devicePixelRatio,
        touchPoints,
        referrer,
        clientHints,
        userAgentSuspected: userAgentFlags.length > 0,
        userAgentFlags,
        fingerprintVersion: DEVICE_FINGERPRINT_VERSION,
        fingerprintHash: hmacValue(fingerprintSource, 'fingerprint')
    };
}

function ipApiFields() {
    const fields = [
        'status',
        'message',
        'country',
        'countryCode',
        'region',
        'regionName',
        'city',
        'zip',
        'lat',
        'lon',
        'timezone',
        'isp',
        'org',
        'as',
        'asname',
        'reverse',
        'mobile',
        'proxy',
        'hosting',
        'query',
        'vpn',
        'tor'
    ].join(',');

    return fields;
}

function providerUrl(provider, ip) {
    const baseUrl = String(provider.baseUrl || '');
    if (provider.type === 'ipapi-is') {
        const url = new URL(baseUrl);
        url.searchParams.set('q', ip);
        return url;
    }
    const endpoint = baseUrl.includes('{ip}')
        ? baseUrl.replace('{ip}', encodeURIComponent(ip))
        : `${trimTrailingSlashes(baseUrl)}/${encodeURIComponent(ip)}`;
    const url = new URL(endpoint);
    if (provider.type === 'ip-api') url.searchParams.set('fields', ipApiFields());
    return url;
}

function normalizeIpapiIsResponse(data = {}, hostname = '') {
    // Custom endpoints historically returned the flat ip-api shape. Preserve
    // compatibility when that shape reaches the new default normalizer.
    if (data.status || data.countryCode || data.proxy !== undefined) {
        return normalizeIpApiResponse(data, hostname);
    }
    if (data.error) throw new Error(String(data.error));
    const location = data.location || {};
    const company = data.company || {};
    const asn = data.asn || {};
    return {
        provider: hostname || 'ipapi.is', raw: data, status: 'success',
        country: location.country, countryCode: location.country_code,
        region: location.state, city: location.city, zip: location.zip,
        lat: location.latitude, lon: location.longitude, timezone: location.timezone,
        isp: company.name || asn.org, org: company.name || asn.org,
        as: asn.asn ? `AS${asn.asn}` : null,
        asname: asn.org || asn.descr, reverse: null,
        mobile: data.is_mobile === true, proxy: data.is_proxy === true,
        hosting: data.is_datacenter === true, vpn: data.is_vpn === true,
        tor: data.is_tor === true, query: data.ip, message: null,
        locationAccuracy: location.accuracy || null,
        securitySignalsAvailable: true
    };
}

function normalizeIpapiCoResponse(data = {}, hostname = '') {
    if (data.error) throw new Error(String(data.reason || data.message || 'ipapi.co lookup failed'));
    return {
        provider: hostname || 'ipapi.co', raw: data, status: 'success',
        country: data.country_name, countryCode: data.country_code || data.country,
        region: data.region, city: data.city, zip: data.postal,
        lat: data.latitude, lon: data.longitude, timezone: data.timezone,
        isp: data.org, org: data.org, as: data.asn, asname: data.org,
        reverse: data.hostname || null, mobile: false, proxy: false,
        hosting: false, vpn: false, tor: false, query: data.ip, message: null,
        locationAccuracy: null,
        securitySignalsAvailable: false
    };
}

function normalizeProviderResponse(provider, data, hostname) {
    if (provider.type === 'ipapi-is') return normalizeIpapiIsResponse(data, hostname);
    if (provider.type === 'ipapi-co') return normalizeIpapiCoResponse(data, hostname);
    if (data.status === 'fail') throw new Error(data.message || 'IP lookup failed');
    return normalizeIpApiResponse(data, hostname);
}

async function lookupWithProvider(provider, ip) {
    const url = providerUrl(provider, ip);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IP_LOOKUP_TIMEOUT_MS);
    timeout.unref?.();

    try {
        const res = await fetch(url.toString(), {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Phomueangtai-Verify/1.1'
            }
        });
        if (!res.ok) throw new Error(`${provider.name} lookup failed: ${res.status}`);
        const data = JSON.parse(await readLimitedResponseText(res, IP_LOOKUP_RESPONSE_MAX_BYTES, controller));
        return normalizeProviderResponse(provider, data, url.hostname);
    } finally {
        clearTimeout(timeout);
    }
}

async function lookupWithRetries(provider, ip) {
    let lastError = null;
    for (let attempt = 1; attempt <= IP_LOOKUP_RETRIES; attempt++) {
        try {
            return await lookupWithProvider(provider, ip);
        } catch (err) {
            lastError = err;
            if (attempt < IP_LOOKUP_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, Math.min(150 * attempt, 400)));
            }
        }
    }
    throw lastError || new Error(`${provider.name} lookup failed`);
}

async function lookupAcrossProviders(ip) {
    const config = getIpLookupConfig();
    if (!config.enabled) throw new Error('IP lookup is disabled');
    const failures = [];
    for (const provider of config.providers) {
        try {
            const result = await lookupWithRetries(provider, ip);
            return {
                ...result,
                attemptedProviders: [...failures.map(item => item.provider), provider.name],
                providerFailures: failures,
                fallbackUsed: failures.length > 0
            };
        } catch (err) {
            failures.push({
                provider: provider.name,
                error: safeSmallString(err?.message || err?.name || 'lookup_failed', 'lookup_failed')
            });
        }
    }
    const error = new Error(failures.map(item => `${item.provider}:${item.error}`).join('; ') || 'All IP lookup providers failed');
    error.providerFailures = failures;
    throw error;
}

function normalizeIpApiResponse(data = {}, hostname = '') {
    return {
        provider: hostname || 'ip-lookup', raw: data, status: data.status,
        country: data.country, countryCode: data.countryCode,
        region: data.regionName || data.region, city: data.city, zip: data.zip,
        lat: data.lat, lon: data.lon, timezone: data.timezone,
        isp: data.isp, org: data.org, as: data.as, asname: data.asname, reverse: data.reverse,
        mobile: data.mobile === true, proxy: data.proxy === true,
        hosting: data.hosting === true, vpn: data.vpn === true, tor: data.tor === true,
        query: data.query, message: data.message || null
    };
}

async function readLimitedResponseText(response, maxBytes, controller = null) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('IP lookup response byte limit is invalid');
    if (!response.body?.getReader) {
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
        controller?.abort();
        throw new Error('IP lookup response exceeded configured byte limit');
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            total += chunk.length;
            if (total > maxBytes) {
                controller?.abort();
                await reader.cancel().catch(() => {});
                throw new Error('IP lookup response exceeded configured byte limit');
            }
            chunks.push(chunk);
        }
        return Buffer.concat(chunks, total).toString('utf8');
    } finally {
        reader.releaseLock?.();
    }
}

function makeLookupDisabledInfo(ip) {
    return {
        provider: 'disabled',
        raw: null,
        status: 'lookup_disabled',

        country: 'unknown',
        countryCode: 'unknown',
        region: 'unknown',
        city: 'unknown',
        zip: 'unknown',
        lat: null,
        lon: null,
        timezone: 'unknown',

        isp: 'lookup disabled',
        org: 'lookup disabled',
        as: 'unknown',
        asname: 'unknown',
        reverse: 'unknown',

        mobile: false,
        proxy: false,
        hosting: false,
        vpn: false,
        tor: false,

        query: ip,
        message: 'External IP lookup is disabled'
    };
}

function makeLookupCircuitOpenInfo(ip) {
    return {
        ...makeLookupDisabledInfo(ip),
        provider: 'circuit_breaker',
        status: 'lookup_failed',
        isp: 'lookup circuit open',
        org: 'lookup circuit open',
        message: 'External IP lookup temporarily paused after repeated failures'
    };
}

function isLookupCircuitOpen(now = Date.now()) {
    return lookupCircuit.openUntil > now;
}

function recordLookupSuccess() {
    lookupCircuit.failures = 0;
    lookupCircuit.openUntil = 0;
    lookupCircuit.lastError = null;
}

function recordLookupFailure(err) {
    lookupCircuit.failures += 1;
    lookupCircuit.lastError = String(err?.message || err?.name || 'lookup_failed').slice(0, 200);

    if (lookupCircuit.failures >= IP_LOOKUP_CIRCUIT_FAIL_THRESHOLD) {
        lookupCircuit.openUntil = Date.now() + IP_LOOKUP_CIRCUIT_OPEN_MS;
    }
}

function sanitizeLookupProviderValue(value, rawIp) {
    if (typeof value === "string") {
        const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, "");
        return rawIp ? cleaned.split(String(rawIp)).join("[redacted-ip]") : cleaned;
    }
    if (!value || typeof value !== "object") return value;

    const json = JSON.stringify(value, (key, item) => {
        const normalizedKey = String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
        if (["query", "ip", "ipaddress", "address"].includes(normalizedKey)) {
            return "[stored-encrypted-separately]";
        }
        if (typeof item === "string") {
            const cleaned = item.replace(/[\u0000-\u001F\u007F]/g, "");
            return rawIp ? cleaned.split(String(rawIp)).join("[redacted-ip]") : cleaned;
        }
        return item;
    });
    return json ? JSON.parse(json) : null;
}

function sanitizedLookupMessage(message, rawIp, maxLength = 200) {
    if (!message) return null;
    return sanitizeLookupProviderValue(String(message), rawIp).slice(0, maxLength);
}

function compactLookupRaw(lookup = {}, rawIp = null) {
    const message = sanitizedLookupMessage(lookup.message, rawIp);

    const sanitizedResponse = sanitizeLookupProviderValue(lookup.raw, rawIp);
    const responseBytes = sanitizedResponse === undefined
        ? 0
        : Buffer.byteLength(JSON.stringify(sanitizedResponse), "utf8");

    return {
        provider: lookup.provider || 'unknown',
        status: lookup.status || 'unknown',
        countryCode: lookup.countryCode || 'unknown',
        proxy: lookup.proxy === true,
        hosting: lookup.hosting === true,
        vpn: lookup.vpn === true,
        tor: lookup.tor === true,
        mobile: lookup.mobile === true,
        locationAccuracy: lookup.locationAccuracy || null,
        securitySignalsAvailable: lookup.securitySignalsAvailable === true,
        fallbackUsed: lookup.fallbackUsed === true,
        attemptedProviders: Array.isArray(lookup.attemptedProviders) ? lookup.attemptedProviders.slice(0, 5) : [],
        providerFailures: Array.isArray(lookup.providerFailures) ? lookup.providerFailures.slice(0, 5) : [],
        message,
        response: responseBytes <= IP_LOOKUP_RESPONSE_MAX_BYTES ? sanitizedResponse : null,
        responseBytes,
        responseTruncated: responseBytes > IP_LOOKUP_RESPONSE_MAX_BYTES
    };
}

function getCacheKey(ip) {
    return hmacValue(normalizeIP(ip), 'ip_lookup_cache') || normalizeIP(ip);
}

function getCachedLookup(ip) {
    const key = getCacheKey(ip);
    const cached = lookupCache.get(key);

    if (!cached) return null;

    if (Date.now() - cached.cachedAt > IP_LOOKUP_CACHE_TTL_MS) {
        lookupCache.delete(key);
        return null;
    }

    return {
        ...cached.value,
        fromCache: true
    };
}

function setCachedLookup(ip, value) {
    const key = getCacheKey(ip);

    if (lookupCache.size >= IP_LOOKUP_CACHE_MAX) {
        const oldestKey = lookupCache.keys().next().value;
        if (oldestKey) lookupCache.delete(oldestKey);
    }

    lookupCache.set(key, {
        cachedAt: Date.now(),
        value
    });
}

function cleanupLookupCache(now = Date.now()) {
    for (const [key, cached] of lookupCache.entries()) {
        if (!cached?.cachedAt || now - cached.cachedAt > IP_LOOKUP_CACHE_TTL_MS) {
            lookupCache.delete(key);
        }
    }

    while (lookupCache.size > IP_LOOKUP_CACHE_MAX) {
        const oldestKey = lookupCache.keys().next().value;
        if (!oldestKey) break;
        lookupCache.delete(oldestKey);
    }
}

function getIpLookupDiagnostics() {
    cleanupLookupCache();
    return {
        cacheSize: lookupCache.size,
        cacheMax: IP_LOOKUP_CACHE_MAX,
        cacheTtlMs: IP_LOOKUP_CACHE_TTL_MS,
        circuitFailures: lookupCircuit.failures,
        circuitOpenUntil: lookupCircuit.openUntil,
        circuitOpen: lookupCircuit.openUntil > Date.now(),
        lastError: lookupCircuit.lastError
    };
}

const lookupCacheCleanupTimer = setInterval(
    cleanupLookupCache,
    Math.max(IP_LOOKUP_CACHE_TTL_MS, 60 * 1000)
);
lookupCacheCleanupTimer.unref?.();

async function lookupIP(ip) {
    if (isPrivateIP(ip)) {
        return {
            provider: 'local',
            raw: null,
            status: 'local',

            country: 'unknown',
            countryCode: 'unknown',
            region: 'unknown',
            city: 'unknown',
            zip: 'unknown',
            lat: null,
            lon: null,
            timezone: 'unknown',

            isp: 'local/private',
            org: 'local/private',
            as: 'unknown',
            asname: 'unknown',
            reverse: 'unknown',

            mobile: false,
            proxy: false,
            hosting: false,
            vpn: false,
            tor: false,

            query: ip,
            message: null
        };
    }

    const cached = getCachedLookup(ip);
    if (cached) return cached;

    if (!getIpLookupConfig().enabled) {
        return makeLookupDisabledInfo(ip);
    }

    if (isLookupCircuitOpen()) {
        return makeLookupCircuitOpenInfo(ip);
    }

    let lookup;
    try {
        lookup = await lookupAcrossProviders(ip);
        recordLookupSuccess();
    } catch (err) {
        recordLookupFailure(err);
        throw err;
    }

    setCachedLookup(ip, lookup);
    return lookup;
}

function includesNetworkKeyword(...values) {
    const text = values.filter(Boolean).join(' ').toLowerCase();

    return /(vpn|proxy|hosting|host|cloud|datacenter|data center|colo|tor|relay|server|vps|aws|amazon|google cloud|azure|ovh|digitalocean|linode|hetzner|oracle|m247|leaseweb|choopa|vultr)/i.test(text);
}

function normalizeNetworkSignals(lookup = {}) {
    const joined = [
        lookup.org,
        lookup.isp,
        lookup.as,
        lookup.asname,
        lookup.reverse
    ].join(' ');

    const proxy = lookup.proxy === true;
    const hosting = lookup.hosting === true || includesNetworkKeyword(joined);
    const tor = lookup.tor === true || /tor/i.test(joined);
    const vpn = lookup.vpn === true || (proxy && includesNetworkKeyword(joined)) || /vpn/i.test(joined);

    return {
        isProxy: proxy,
        isVPN: vpn,
        isTOR: tor,
        hosting,
        mobile: lookup.mobile === true
    };
}

function buildNetworkFindings(flags = {}, lookupStatus = 'unknown', headerMeta = {}) {
    const findings = [];

    if (flags.isVPN) findings.push('vpn');
    if (flags.isProxy) findings.push('proxy');
    if (flags.isTOR) findings.push('tor');
    if (flags.hosting) findings.push('hosting');
    if (lookupStatus === 'lookup_failed') findings.push('lookup_failed');
    if (lookupStatus === 'ip_unknown') findings.push('ip_unknown');
    if (lookupStatus === 'lookup_disabled') findings.push('lookup_disabled');
    if (headerMeta.spoofSuspected) findings.push('spoofed_header');

    for (const flag of headerMeta.spoofFlags || []) {
        findings.push(flag);
    }

    return Array.from(new Set(findings));
}

function makeUnknownIpInfo({ trustedIp, headerMeta }) {
    const hasSourceIp = isValidIP(trustedIp.ip) && !isPrivateIP(trustedIp.ip);
    const findings = buildNetworkFindings({}, 'ip_unknown', headerMeta);

    return {
        encryptedRawIp: hasSourceIp ? encryptIP(trustedIp.ip) : null,
        ipHash: hasSourceIp ? hmacValue(trustedIp.ip, 'ip') : null,

        country: 'unknown',
        countryCode: 'unknown',
        region: 'unknown',
        city: 'unknown',
        zip: 'unknown',
        lat: null,
        lon: null,
        timezone: 'unknown',

        isp: 'unknown',
        org: 'unknown',
        as: 'unknown',
        asname: 'unknown',
        reverse: 'unknown',

        isProxy: false,
        isVPN: false,
        isTOR: false,
        hosting: false,
        mobile: false,

        findings,

        lookupProvider: 'local',
        lookupStatus: 'ip_unknown',
        lookupMessage: 'Unable to determine trusted public client IP',
        lookupProviders: [],
        lookupFallbackUsed: false,
        locationAccuracy: null,
        securitySignalsAvailable: false,
        lookupRaw: compactLookupRaw({
            provider: 'local',
            status: 'ip_unknown',
            message: 'Unable to determine trusted public client IP'
        }, trustedIp.ip),

        ipSource: trustedIp.source || 'unknown',
        headerIps: storedHeaderIpMetadata(headerMeta.headerIps),
        spoofSuspected: headerMeta.spoofSuspected,
        spoofFlags: headerMeta.spoofFlags,
        headerIpConflict: headerMeta.headerIpConflict,

        proxyCheckProvider: null,
        proxyCheckStatus: null,
        proxyCheckRaw: null,

        lookupAt: Date.now()
    };
}

async function processIP(req) {
    const trustedIp = getTrustedRequestIp(req);
    const rawIp = trustedIp.ip;
    const headerMeta = detectSpoofedHeaders(req, rawIp);

    if (!isValidIP(rawIp) || isPrivateIP(rawIp)) {
        return makeUnknownIpInfo({ trustedIp, headerMeta });
    }

    let lookup = {};

    try {
        lookup = await lookupIP(rawIp);
    } catch (err) {
        lookup = {
            provider: 'lookup_failed',
            raw: null,
            status: 'lookup_failed',
            message: safeSmallString(err?.name || 'IP lookup failed', 'IP lookup failed'),
            query: null,

            country: 'unknown',
            countryCode: 'unknown',
            region: 'unknown',
            city: 'unknown',
            zip: 'unknown',
            lat: null,
            lon: null,
            timezone: 'unknown',

            isp: 'unknown',
            org: 'unknown',
            as: 'unknown',
            asname: 'unknown',
            reverse: 'unknown',

            mobile: false,
            proxy: false,
            hosting: false,
            vpn: false,
            tor: false
        };
    }

    const flags = normalizeNetworkSignals(lookup);
    const findings = buildNetworkFindings(flags, lookup.status || 'unknown', headerMeta);

    return {
        encryptedRawIp: encryptIP(rawIp),
        ipHash: hmacValue(rawIp, 'ip'),

        country: lookup.country || 'unknown',
        countryCode: lookup.countryCode || 'unknown',
        region: lookup.region || 'unknown',
        city: lookup.city || 'unknown',
        zip: lookup.zip || 'unknown',
        lat: typeof lookup.lat === 'number' ? lookup.lat : null,
        lon: typeof lookup.lon === 'number' ? lookup.lon : null,
        timezone: lookup.timezone || 'unknown',

        isp: lookup.isp || 'unknown',
        org: lookup.org || 'unknown',
        as: lookup.as || 'unknown',
        asname: lookup.asname || 'unknown',
        reverse: lookup.reverse || 'unknown',

        isProxy: flags.isProxy,
        isVPN: flags.isVPN,
        isTOR: flags.isTOR,
        hosting: flags.hosting,
        mobile: flags.mobile,

        findings,

        lookupProvider: lookup.provider || 'unknown',
        lookupStatus: lookup.status || 'unknown',
        lookupMessage: sanitizedLookupMessage(lookup.message, rawIp),
        lookupProviders: Array.isArray(lookup.attemptedProviders) ? lookup.attemptedProviders : [],
        lookupFallbackUsed: lookup.fallbackUsed === true,
        locationAccuracy: lookup.locationAccuracy || null,
        securitySignalsAvailable: lookup.securitySignalsAvailable === true,
        lookupRaw: compactLookupRaw(lookup, rawIp),

        ipSource: trustedIp.source,
        headerIps: storedHeaderIpMetadata(headerMeta.headerIps),
        spoofSuspected: headerMeta.spoofSuspected,
        spoofFlags: headerMeta.spoofFlags,
        headerIpConflict: headerMeta.headerIpConflict,

        proxyCheckProvider: null,
        proxyCheckStatus: null,
        proxyCheckRaw: null,

        lookupAt: Date.now()
    };
}

module.exports = {
    getRealIP,
    normalizeIP,
    getTrustedRequestIp,
    getIpLookupConfig,
    lookupIP,
    cleanupLookupCache,
    getIpLookupDiagnostics,
    isPrivateIP,
    extractDevice,
    processIP,
    compactLookupRaw,
    _test: {
        splitHeaderIps,
        X_FORWARDED_FOR_MAX_ENTRIES,
        storedHeaderIpMetadata,
        sanitizedLookupMessage,
        resolveResponseMaxBytes,
        readLimitedResponseText,
        makeUnknownIpInfo,
        normalizeIpapiIsResponse,
        normalizeIpapiCoResponse,
        detectUserAgentAnomalies
    }
};
