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
const DEFAULT_MAXMIND_CITY_URL = 'https://geoip.maxmind.com/geoip/v2.1/city/{ip}';
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
const DEFAULT_IP_LOOKUP_HOSTS = Object.freeze(['api.ipapi.is', 'ipapi.co', 'geoip.maxmind.com']);
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
    const consensusRaw = String(process.env.IP_LOOKUP_CONSENSUS_ENABLED ?? 'true').trim().toLowerCase();
    const consensusEnabled = !['0', 'false', 'no', 'off', 'disabled'].includes(consensusRaw);
    const maxmindRaw = String(process.env.MAXMIND_IP_LOOKUP_ENABLED ?? 'true').trim().toLowerCase();
    const maxmindConfigured = !!String(process.env.MAXMIND_ACCOUNT_ID || '').trim() &&
        !!String(process.env.MAXMIND_LICENSE_KEY || '').trim();
    const maxmindEnabled = maxmindConfigured &&
        !['0', 'false', 'no', 'off', 'disabled'].includes(maxmindRaw);
    const baseUrl = customBaseUrl || DEFAULT_IP_LOOKUP_API_BASE_URL;

    return {
        enabled,
        baseUrl,
        fallbackEnabled,
        consensusEnabled,
        maxmindEnabled,
        providers: [
            ...(maxmindEnabled
                ? [{ name: 'maxmind', baseUrl: DEFAULT_MAXMIND_CITY_URL, type: 'maxmind' }]
                : []),
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
        'tor',
        'anycast',
        'networkType',
        'accuracyRadiusKm'
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

function providerHeaders(provider) {
    const headers = {
        'User-Agent': 'Phomueangtai-Verify/1.2',
        'Accept': 'application/json'
    };
    if (provider.type !== 'maxmind') return headers;

    const accountId = String(process.env.MAXMIND_ACCOUNT_ID || '').trim();
    const licenseKey = String(process.env.MAXMIND_LICENSE_KEY || '').trim();
    if (!accountId || !licenseKey) throw new Error('MaxMind credentials are not configured');
    const credentials = `${accountId}:${licenseKey}`;
    headers.Authorization = `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
    return headers;
}

function configuredLookupHosts() {
    const configured = String(process.env.IP_LOOKUP_ALLOWED_HOSTS || '')
        .split(',')
        .map(value => value.trim().toLowerCase())
        .filter(host => /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/.test(host));
    return new Set([...DEFAULT_IP_LOOKUP_HOSTS, ...configured]);
}

function validateLookupTarget(url) {
    if (!(url instanceof URL)) throw new Error('IP lookup URL is invalid');
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password) {
        throw new Error('IP lookup URL must use credential-free HTTPS');
    }
    if (url.port && url.port !== '443') throw new Error('IP lookup URL port is not allowed');
    if (!configuredLookupHosts().has(hostname)) throw new Error('IP lookup hostname is not allowlisted');
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
        anycast: data.is_anycast === true,
        networkType: company.type || asn.type || null,
        accuracyRadiusKm: safeNumber(location.accuracy, null),
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
        anycast: false, networkType: data.network || null,
        accuracyRadiusKm: null,
        locationAccuracy: null,
        securitySignalsAvailable: false
    };
}

function maxmindName(value = {}) {
    if (!value || typeof value !== 'object') return null;
    return value.en || Object.values(value).find(Boolean) || null;
}

function normalizeMaxMindResponse(data = {}, hostname = '') {
    if (data.error || data.code) {
        throw new Error(String(data.error || data.code || 'MaxMind lookup failed'));
    }
    const location = data.location || {};
    const traits = data.traits || {};
    const subdivision = Array.isArray(data.subdivisions) ? data.subdivisions[0] || {} : {};
    const asNumber = traits.autonomous_system_number;
    return {
        provider: hostname || 'maxmind', raw: data, status: 'success',
        country: maxmindName(data.country?.names), countryCode: data.country?.iso_code,
        region: maxmindName(subdivision.names), city: maxmindName(data.city?.names),
        zip: data.postal?.code, lat: location.latitude, lon: location.longitude,
        timezone: location.time_zone, isp: traits.isp || traits.organization,
        org: traits.organization || traits.autonomous_system_organization,
        as: asNumber ? `AS${asNumber}` : null,
        asname: traits.autonomous_system_organization, reverse: traits.domain || null,
        mobile: traits.connection_type === 'Cellular',
        proxy: traits.is_anonymous_proxy === true || traits.is_public_proxy === true,
        hosting: traits.user_type === 'hosting' || traits.user_type === 'content_delivery_network',
        vpn: traits.is_anonymous_vpn === true,
        tor: traits.is_tor_exit_node === true,
        anycast: traits.is_anycast === true,
        networkType: traits.connection_type || traits.user_type || null,
        query: null, message: null,
        accuracyRadiusKm: safeNumber(location.accuracy_radius, null),
        locationAccuracy: location.accuracy_radius == null ? null : `±${location.accuracy_radius} km`,
        countryConfidence: safeNumber(data.country?.confidence, null),
        regionConfidence: safeNumber(subdivision.confidence, null),
        cityConfidence: safeNumber(data.city?.confidence, null),
        postalConfidence: safeNumber(data.postal?.confidence, null),
        securitySignalsAvailable: true
    };
}

function normalizeProviderResponse(provider, data, hostname) {
    if (provider.type === 'maxmind') return normalizeMaxMindResponse(data, hostname);
    if (provider.type === 'ipapi-is') return normalizeIpapiIsResponse(data, hostname);
    if (provider.type === 'ipapi-co') return normalizeIpapiCoResponse(data, hostname);
    if (data.status === 'fail') throw new Error(data.message || 'IP lookup failed');
    return normalizeIpApiResponse(data, hostname);
}

async function lookupWithProvider(provider, ip) {
    const safeIp = normalizeIP(ip);
    if (net.isIP(safeIp) === 0) throw new Error('IP lookup requires a valid IP address');
    const url = validateLookupTarget(providerUrl(provider, safeIp));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IP_LOOKUP_TIMEOUT_MS);
    timeout.unref?.();

    try {
        // nosemgrep -- The target is HTTPS, credential-free, host-allowlisted, and built from a net.isIP-validated value above.
        const res = await fetch(url.toString(), {
            signal: controller.signal,
            headers: providerHeaders(provider)
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

function usefulProviderValue(value) {
    if (value === undefined || value === null || value === '') return false;
    return !['unknown', 'n/a', 'null'].includes(String(value).trim().toLowerCase());
}

function comparableProviderValue(value) {
    return usefulProviderValue(value)
        ? String(value).trim().toLowerCase().replace(/\s+/g, ' ')
        : null;
}

function providerAgreement(results, field) {
    const groups = new Map();
    for (const result of results) {
        const normalized = comparableProviderValue(result[field]);
        if (!normalized) continue;
        const current = groups.get(normalized) || { value: result[field], count: 0, providers: [] };
        current.count += 1;
        current.providers.push(result.provider);
        groups.set(normalized, current);
    }
    const ordered = [...groups.values()].sort((left, right) => right.count - left.count);
    const best = ordered[0] || null;
    const considered = ordered.reduce((sum, item) => sum + item.count, 0);
    return {
        value: best?.value ?? null,
        agreed: !!best && best.count >= 2,
        topCount: best?.count || 0,
        considered,
        ratio: considered > 0 ? (best?.count || 0) / considered : 0,
        conflict: ordered.length > 1,
        providers: best?.providers || []
    };
}

function firstUseful(results, field, fallback = null) {
    const found = results.find(result => usefulProviderValue(result[field]));
    return found ? found[field] : fallback;
}

function locationSource(results, consensus) {
    const candidates = results.filter(result => Number.isFinite(Number(result.lat)) && Number.isFinite(Number(result.lon)));
    if (!candidates.length) return null;
    const matching = candidates.filter(result => {
        const countryMatch = !consensus.countryCode.value ||
            comparableProviderValue(result.countryCode) === comparableProviderValue(consensus.countryCode.value);
        const regionMatch = !consensus.region.agreed ||
            comparableProviderValue(result.region) === comparableProviderValue(consensus.region.value);
        const cityMatch = !consensus.city.agreed ||
            comparableProviderValue(result.city) === comparableProviderValue(consensus.city.value);
        return countryMatch && regionMatch && cityMatch;
    });
    const pool = matching.length ? matching : candidates;
    return [...pool].sort((left, right) => {
        const leftRadius = Number.isFinite(Number(left.accuracyRadiusKm)) ? Number(left.accuracyRadiusKm) : Infinity;
        const rightRadius = Number.isFinite(Number(right.accuracyRadiusKm)) ? Number(right.accuracyRadiusKm) : Infinity;
        return leftRadius - rightRadius;
    })[0];
}

function confidenceLabel(score, { providerCount, obscured, countryConflict }) {
    if (!providerCount) return 'unknown';
    if (obscured || countryConflict || score < 50) return 'low';
    if (providerCount >= 2 && score >= 80) return 'high';
    return 'medium';
}

function providerCountConfidence(providerCount) {
    return providerCount < 2
        ? { score: 40, reasons: ['single_provider'] }
        : { score: 55, reasons: [] };
}

function agreementConfidence(value, dimension, agreedScore, conflictScore) {
    if (value.agreed) {
        return { score: agreedScore, reasons: [`providers_agree_${dimension}`] };
    }
    if (value.conflict) {
        return { score: conflictScore, reasons: [`providers_disagree_${dimension}`] };
    }
    return { score: 0, reasons: [] };
}

function accuracyConfidence(accuracyRadiusKm) {
    if (!Number.isFinite(accuracyRadiusKm)) {
        return { score: 0, reasons: ['accuracy_radius_unavailable'] };
    }

    let score = 0;
    if (accuracyRadiusKm <= 50) score += 5;
    if (accuracyRadiusKm >= 250) score -= 10;
    return { score, reasons: ['provider_supplied_accuracy_radius'] };
}

function networkFlagConfidence(flags) {
    const reasons = [];
    let score = 0;
    if (flags.mobile) {
        score -= 10;
        reasons.push('mobile_or_cgnat_location');
    }
    if (flags.anycast) {
        score -= 15;
        reasons.push('anycast_location');
    }
    if (flags.hosting) {
        score -= 20;
        reasons.push('hosting_location');
    }
    if (flags.isVPN || flags.isProxy || flags.isTOR) {
        score -= 35;
        reasons.push('network_exit_location');
    }
    return { score, reasons };
}

function locationIsObscured(flags) {
    return flags.isVPN || flags.isProxy || flags.isTOR || flags.hosting || flags.anycast;
}

function locationConfidence(results, agreement, flags, accuracyRadiusKm) {
    const contributions = [
        providerCountConfidence(results.length),
        agreementConfidence(agreement.countryCode, 'country', 15, -25),
        agreementConfidence(agreement.region, 'region', 10, -10),
        agreementConfidence(agreement.city, 'city', 10, -5),
        accuracyConfidence(accuracyRadiusKm),
        networkFlagConfidence(flags)
    ];
    let score = contributions.reduce((sum, contribution) => sum + contribution.score, 0);
    const reasons = contributions.flatMap(contribution => contribution.reasons);
    score = Math.max(0, Math.min(100, Math.round(score)));
    return {
        score,
        label: confidenceLabel(score, {
            providerCount: results.length,
            obscured: locationIsObscured(flags),
            countryConflict: agreement.countryCode.conflict
        }),
        reasons: [...new Set(reasons)]
    };
}

function providerEvidence(result) {
    return {
        provider: result.provider || 'unknown',
        countryCode: result.countryCode || null,
        region: result.region || null,
        city: result.city || null,
        lat: safeNumber(result.lat, null),
        lon: safeNumber(result.lon, null),
        accuracyRadiusKm: safeNumber(result.accuracyRadiusKm, null),
        as: result.as || null,
        networkType: result.networkType || null,
        securitySignalsAvailable: result.securitySignalsAvailable === true
    };
}

function mergeProviderResults(results, failures, attemptedProviders) {
    const agreement = {
        countryCode: providerAgreement(results, 'countryCode'),
        region: providerAgreement(results, 'region'),
        city: providerAgreement(results, 'city'),
        as: providerAgreement(results, 'as')
    };
    const source = locationSource(results, agreement) || results[0];
    const flags = {
        mobile: results.some(result => result.mobile === true),
        proxy: results.some(result => result.proxy === true),
        hosting: results.some(result => result.hosting === true),
        vpn: results.some(result => result.vpn === true),
        tor: results.some(result => result.tor === true),
        anycast: results.some(result => result.anycast === true)
    };
    const reportedRadii = results
        .map(result => safeNumber(result.accuracyRadiusKm, null))
        .filter(Number.isFinite);
    const accuracyRadiusKm = reportedRadii.length ? Math.max(...reportedRadii) : null;
    const confidence = locationConfidence(results, agreement, {
        isVPN: flags.vpn,
        isProxy: flags.proxy,
        isTOR: flags.tor,
        hosting: flags.hosting,
        mobile: flags.mobile,
        anycast: flags.anycast
    }, accuracyRadiusKm);
    return {
        ...source,
        provider: results.length > 1 ? 'consensus' : source.provider,
        status: 'success',
        raw: null,
        country: firstUseful(results.filter(result => comparableProviderValue(result.countryCode) === comparableProviderValue(agreement.countryCode.value)), 'country', firstUseful(results, 'country')),
        countryCode: agreement.countryCode.value || firstUseful(results, 'countryCode'),
        region: agreement.region.value || firstUseful(results, 'region'),
        city: agreement.city.value || firstUseful(results, 'city'),
        zip: firstUseful(results, 'zip'),
        lat: safeNumber(source?.lat, null),
        lon: safeNumber(source?.lon, null),
        timezone: firstUseful(results, 'timezone'),
        isp: firstUseful(results, 'isp'),
        org: firstUseful(results, 'org'),
        as: agreement.as.value || firstUseful(results, 'as'),
        asname: firstUseful(results, 'asname'),
        reverse: firstUseful(results, 'reverse'),
        networkType: firstUseful(results, 'networkType'),
        ...flags,
        accuracyRadiusKm,
        locationAccuracy: Number.isFinite(accuracyRadiusKm) ? `±${accuracyRadiusKm} km` : null,
        locationConfidence: confidence.label,
        locationConfidenceScore: confidence.score,
        locationConfidenceReasons: confidence.reasons,
        providerAgreement: agreement,
        providerEvidence: results.map(providerEvidence),
        providerCount: results.length,
        consensusUsed: results.length > 1,
        securitySignalsAvailable: results.some(result => result.securitySignalsAvailable === true),
        attemptedProviders,
        providerFailures: failures,
        fallbackUsed: failures.length > 0,
        message: failures.length ? 'Some IP lookup providers failed; available results were preserved' : null
    };
}

async function lookupAcrossProviders(ip) {
    const config = getIpLookupConfig();
    if (!config.enabled) throw new Error('IP lookup is disabled');
    if (!config.consensusEnabled) {
        const failures = [];
        for (const provider of config.providers) {
            try {
                const result = await lookupWithRetries(provider, ip);
                return mergeProviderResults([result], failures, [...failures.map(item => item.provider), provider.name]);
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

    const settled = await Promise.allSettled(
        config.providers.map(provider => lookupWithRetries(provider, ip))
    );
    const results = [];
    const failures = [];
    settled.forEach((item, index) => {
        const provider = config.providers[index];
        if (item.status === 'fulfilled') {
            results.push(item.value);
        } else {
            failures.push({
                provider: provider.name,
                error: safeSmallString(item.reason?.message || item.reason?.name || 'lookup_failed', 'lookup_failed')
            });
        }
    });
    if (results.length) return mergeProviderResults(results, failures, config.providers.map(provider => provider.name));
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
        anycast: data.anycast === true, networkType: data.networkType || null,
        accuracyRadiusKm: safeNumber(data.accuracyRadiusKm ?? data.accuracy_radius, null),
        query: data.query, message: data.message || null,
        securitySignalsAvailable: data.proxy !== undefined || data.vpn !== undefined || data.tor !== undefined
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
        anycast: false,
        networkType: null,
        accuracyRadiusKm: null,
        locationAccuracy: null,
        locationConfidence: 'unknown',
        locationConfidenceScore: null,
        locationConfidenceReasons: ['lookup_disabled'],
        providerAgreement: null,
        providerEvidence: [],
        providerCount: 0,
        consensusUsed: false,
        securitySignalsAvailable: false,

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
        anycast: lookup.anycast === true,
        networkType: lookup.networkType || null,
        accuracyRadiusKm: safeNumber(lookup.accuracyRadiusKm, null),
        locationAccuracy: lookup.locationAccuracy || null,
        locationConfidence: lookup.locationConfidence || 'unknown',
        locationConfidenceScore: safeNumber(lookup.locationConfidenceScore, null),
        locationConfidenceReasons: Array.isArray(lookup.locationConfidenceReasons)
            ? lookup.locationConfidenceReasons.slice(0, 20)
            : [],
        providerAgreement: lookup.providerAgreement || null,
        providerEvidence: Array.isArray(lookup.providerEvidence)
            ? lookup.providerEvidence.slice(0, 5)
            : [],
        providerCount: Number(lookup.providerCount || 0),
        consensusUsed: lookup.consensusUsed === true,
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
            anycast: false,
            networkType: null,
            accuracyRadiusKm: null,
            locationAccuracy: null,
            locationConfidence: 'unknown',
            locationConfidenceScore: null,
            locationConfidenceReasons: ['private_or_reserved_ip'],
            providerAgreement: null,
            providerEvidence: [],
            providerCount: 0,
            consensusUsed: false,
            securitySignalsAvailable: false,

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
        mobile: lookup.mobile === true,
        anycast: lookup.anycast === true,
        networkType: lookup.networkType || null
    };
}

function adjustedConfidenceLabel(score, lookup = {}) {
    const obscured = lookup.vpn === true || lookup.proxy === true || lookup.tor === true ||
        lookup.hosting === true || lookup.anycast === true;
    return confidenceLabel(score, {
        providerCount: Number(lookup.providerCount || 0),
        obscured,
        countryConflict: lookup.providerAgreement?.countryCode?.conflict === true
    });
}

function applyRequestLocationContext(lookup = {}, req = {}, headerMeta = {}) {
    let score = Number.isFinite(Number(lookup.locationConfidenceScore))
        ? Number(lookup.locationConfidenceScore)
        : 0;
    const reasons = Array.isArray(lookup.locationConfidenceReasons)
        ? [...lookup.locationConfidenceReasons]
        : [];
    const browserTimezone = safeSmallString(req.body?.timezone || '');
    let browserTimezoneMatches = null;
    if (browserTimezone && usefulProviderValue(lookup.timezone)) {
        browserTimezoneMatches = browserTimezone === lookup.timezone;
        if (browserTimezoneMatches) {
            score += 5;
            reasons.push('browser_timezone_matches');
        } else {
            score -= 5;
            reasons.push('browser_timezone_differs');
        }
    }
    if (headerMeta.spoofSuspected) {
        score -= 20;
        reasons.push('forwarded_header_conflict');
    }
    score = Math.max(0, Math.min(100, Math.round(score)));
    return {
        ...lookup,
        locationConfidenceScore: score,
        locationConfidence: adjustedConfidenceLabel(score, lookup),
        locationConfidenceReasons: [...new Set(reasons)],
        browserTimezone: browserTimezone || null,
        browserTimezoneMatches
    };
}

function applyHistoricalLocationContext(ipInfo = {}, history = null) {
    if (!history) return ipInfo;
    let score = Number.isFinite(Number(ipInfo.locationConfidenceScore))
        ? Number(ipInfo.locationConfidenceScore)
        : 0;
    const reasons = Array.isArray(ipInfo.locationConfidenceReasons)
        ? [...ipInfo.locationConfidenceReasons]
        : [];
    const comparisons = [
        ['country', ipInfo.countryCode, history.lastCountryCode],
        ['region', ipInfo.region, history.lastRegion],
        ['asn', ipInfo.as, history.lastAs]
    ].filter(([, current, previous]) => usefulProviderValue(current) && usefulProviderValue(previous));
    const matches = comparisons.filter(([, current, previous]) =>
        comparableProviderValue(current) === comparableProviderValue(previous));
    const conflicts = comparisons.filter(([, current, previous]) =>
        comparableProviderValue(current) !== comparableProviderValue(previous));
    if (matches.length) {
        score += Math.min(5, matches.length * 2);
        reasons.push('historical_network_matches');
    }
    if (conflicts.length) {
        score -= Math.min(15, conflicts.length * 5);
        reasons.push('historical_network_differs');
    }
    score = Math.max(0, Math.min(100, Math.round(score)));
    return {
        ...ipInfo,
        locationConfidenceScore: score,
        locationConfidence: adjustedConfidenceLabel(score, {
            ...ipInfo,
            vpn: ipInfo.isVPN,
            proxy: ipInfo.isProxy,
            tor: ipInfo.isTOR,
            providerCount: ipInfo.lookupProviderCount
        }),
        locationConfidenceReasons: [...new Set(reasons)],
        historyConsistency: {
            compared: comparisons.length > 0,
            matches: matches.map(([field]) => field),
            conflicts: conflicts.map(([field]) => field)
        }
    };
}

function buildNetworkFindings(flags = {}, lookupStatus = 'unknown', headerMeta = {}) {
    const findings = [];

    if (flags.isVPN) findings.push('vpn');
    if (flags.isProxy) findings.push('proxy');
    if (flags.isTOR) findings.push('tor');
    if (flags.hosting) findings.push('hosting');
    if (flags.anycast) findings.push('anycast');
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
        anycast: false,
        networkType: null,

        findings,

        lookupProvider: 'local',
        lookupStatus: 'ip_unknown',
        lookupMessage: 'Unable to determine trusted public client IP',
        lookupProviders: [],
        lookupFallbackUsed: false,
        lookupConsensusUsed: false,
        lookupProviderCount: 0,
        accuracyRadiusKm: null,
        locationAccuracy: null,
        locationConfidence: 'unknown',
        locationConfidenceScore: null,
        locationConfidenceReasons: ['trusted_public_ip_unavailable'],
        providerAgreement: null,
        providerEvidence: [],
        browserTimezone: null,
        browserTimezoneMatches: null,
        historyConsistency: null,
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

    lookup = applyRequestLocationContext(lookup, req, headerMeta);
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
        anycast: flags.anycast,
        networkType: flags.networkType,

        findings,

        lookupProvider: lookup.provider || 'unknown',
        lookupStatus: lookup.status || 'unknown',
        lookupMessage: sanitizedLookupMessage(lookup.message, rawIp),
        lookupProviders: Array.isArray(lookup.attemptedProviders) ? lookup.attemptedProviders : [],
        lookupFallbackUsed: lookup.fallbackUsed === true,
        lookupConsensusUsed: lookup.consensusUsed === true,
        lookupProviderCount: Number(lookup.providerCount || 0),
        accuracyRadiusKm: safeNumber(lookup.accuracyRadiusKm, null),
        locationAccuracy: lookup.locationAccuracy || null,
        locationConfidence: lookup.locationConfidence || 'unknown',
        locationConfidenceScore: safeNumber(lookup.locationConfidenceScore, null),
        locationConfidenceReasons: Array.isArray(lookup.locationConfidenceReasons)
            ? lookup.locationConfidenceReasons
            : [],
        providerAgreement: lookup.providerAgreement || null,
        providerEvidence: Array.isArray(lookup.providerEvidence) ? lookup.providerEvidence : [],
        browserTimezone: lookup.browserTimezone || null,
        browserTimezoneMatches: lookup.browserTimezoneMatches ?? null,
        historyConsistency: null,
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
    applyHistoricalLocationContext,
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
        normalizeMaxMindResponse,
        mergeProviderResults,
        providerAgreement,
        applyRequestLocationContext,
        providerUrl,
        providerHeaders,
        detectUserAgentAnomalies,
        validateLookupTarget
    }
};
