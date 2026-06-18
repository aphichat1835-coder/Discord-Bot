const net = require('net');
const { encryptIP, hmacValue } = require('./crypto');

const ENABLE_CF_IP_HEADER = String(process.env.ENABLE_CF_IP_HEADER || '').toLowerCase() === 'true';
const IP_LOOKUP_TIMEOUT_MS = 3000;
const IP_LOOKUP_CACHE_TTL_MS = 10 * 60 * 1000;
const IP_LOOKUP_CACHE_MAX = 5000;
const IP_LOOKUP_CIRCUIT_FAIL_THRESHOLD = Math.max(1, Number(process.env.IP_LOOKUP_CIRCUIT_FAIL_THRESHOLD || 10) || 10);
const IP_LOOKUP_CIRCUIT_OPEN_MS = Math.max(10000, Number(process.env.IP_LOOKUP_CIRCUIT_OPEN_MS || 5 * 60 * 1000) || 5 * 60 * 1000);
const DEVICE_FINGERPRINT_VERSION = 1;
const IPV4_MASK_ALL = 2 ** 32 - 1;
const DEFAULT_IP_LOOKUP_API_BASE_URL = 'https://ip-api.com/json';
const lookupCache = new Map();
const lookupCircuit = {
    failures: 0,
    openUntil: 0,
    lastError: null
};

function getIpLookupConfig() {
    const enabledRaw = String(process.env.IP_LOOKUP_ENABLED ?? 'true').trim().toLowerCase();
    const enabled = !['0', 'false', 'no', 'off', 'disabled'].includes(enabledRaw);
    const baseUrl = String(process.env.IP_LOOKUP_API_BASE_URL || DEFAULT_IP_LOOKUP_API_BASE_URL).trim();

    return {
        enabled,
        baseUrl: baseUrl || DEFAULT_IP_LOOKUP_API_BASE_URL
    };
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
        .slice(0, 20);
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

    if (ENABLE_CF_IP_HEADER && isValidIP(cfConnectingIp) && !isPrivateIP(cfConnectingIp)) {
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

    if (rawPlatform && rawPlatform !== 'Unknown') {
        if (/iphone|ipad|ipod/i.test(rawPlatform)) return 'iOS';
        if (/android/i.test(rawPlatform)) return 'Android';
        if (/win/i.test(rawPlatform)) return 'Windows';
        if (/mac/i.test(rawPlatform)) return 'macOS';
        if (/linux/i.test(rawPlatform)) return 'Linux';
        return rawPlatform.slice(0, 80);
    }

    if (/Android/i.test(ua)) return 'Android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
    if (/Windows/i.test(ua)) return 'Windows';
    if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';
    if (/Linux/i.test(ua)) return 'Linux';

    return 'Unknown';
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
    return String(value).slice(0, 500);
}

function safeSmallString(value, fallback = '') {
    if (value === undefined || value === null) return fallback;
    return String(value).slice(0, 120);
}

function safeNumber(value, fallback = null) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function safeLanguages(value, fallbackLanguage = '') {
    if (Array.isArray(value)) {
        return value
            .map(v => safeSmallString(v, ''))
            .filter(Boolean)
            .slice(0, 12);
    }

    if (fallbackLanguage) return [fallbackLanguage];

    return [];
}

function extractDevice(req) {
    const ua = req.headers['user-agent'] || '';
    const body = req.body || {};

    const browser = parseBrowser(ua);
    const platform = safeSmallString(body.platform || 'Unknown', 'Unknown');
    const os = parseOS(ua, platform);
    const deviceType = parseDeviceType(ua, body);

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
    const referrer = safeString(body.referrer || '', '');

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
        timezone,
        platform,
        deviceType,
        screenSize,
        viewportSize,
        colorDepth,
        devicePixelRatio,
        touchPoints,
        referrer,
        fingerprintVersion: DEVICE_FINGERPRINT_VERSION,
        fingerprintHash: hmacValue(fingerprintSource, 'fingerprint')
    };
}

async function lookupWithIpApi(ip) {
    const config = getIpLookupConfig();
    if (!config.enabled) {
        throw new Error('IP lookup is disabled');
    }

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

    const endpoint = config.baseUrl.includes('{ip}')
        ? config.baseUrl.replace('{ip}', encodeURIComponent(ip))
        : `${config.baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(ip)}`;
    const url = new URL(endpoint);
    url.searchParams.set('fields', fields);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IP_LOOKUP_TIMEOUT_MS);

    let res;

    try {
        res = await fetch(url.toString(), {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Phomueangtai-Verify/1.1'
            }
        });
    } finally {
        clearTimeout(timeout);
    }

    if (!res.ok) throw new Error(`ip-api lookup failed: ${res.status}`);

    const data = await res.json();

    if (data.status === 'fail') {
        throw new Error(data.message || 'ip-api lookup failed');
    }

    return {
        provider: url.hostname || 'ip-lookup',
        raw: data,
        status: data.status,

        country: data.country,
        countryCode: data.countryCode,
        region: data.regionName || data.region,
        city: data.city,
        zip: data.zip,
        lat: data.lat,
        lon: data.lon,
        timezone: data.timezone,

        isp: data.isp,
        org: data.org,
        as: data.as,
        asname: data.asname,
        reverse: data.reverse,

        mobile: data.mobile === true,
        proxy: data.proxy === true,
        hosting: data.hosting === true,
        vpn: data.vpn === true,
        tor: data.tor === true,

        query: data.query,
        message: data.message || null
    };
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

function compactLookupRaw(lookup = {}) {
    const message = lookup.message
        ? String(lookup.message).replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 200)
        : null;

    return {
        provider: lookup.provider || 'unknown',
        status: lookup.status || 'unknown',
        countryCode: lookup.countryCode || 'unknown',
        proxy: lookup.proxy === true,
        hosting: lookup.hosting === true,
        vpn: lookup.vpn === true,
        tor: lookup.tor === true,
        mobile: lookup.mobile === true,
        message
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
        lookup = await lookupWithIpApi(ip);
        recordLookupSuccess();
    } catch (err) {
        recordLookupFailure(err);
        throw err;
    }

    setCachedLookup(ip, lookup);
    return lookup;
}

function includesRiskKeyword(...values) {
    const text = values.filter(Boolean).join(' ').toLowerCase();

    return /(vpn|proxy|hosting|host|cloud|datacenter|data center|colo|tor|relay|server|vps|aws|amazon|google cloud|azure|ovh|digitalocean|linode|hetzner|oracle|m247|leaseweb|choopa|vultr)/i.test(text);
}

function normalizeRiskFlags(lookup = {}) {
    const joined = [
        lookup.org,
        lookup.isp,
        lookup.as,
        lookup.asname,
        lookup.reverse
    ].join(' ');

    const proxy = lookup.proxy === true;
    const hosting = lookup.hosting === true || includesRiskKeyword(joined);
    const tor = lookup.tor === true || /tor/i.test(joined);
    const vpn = lookup.vpn === true || (proxy && includesRiskKeyword(joined)) || /vpn/i.test(joined);

    return {
        isProxy: proxy,
        isVPN: vpn,
        isTOR: tor,
        hosting,
        mobile: lookup.mobile === true
    };
}

function buildRiskFlags(flags = {}, lookupStatus = 'unknown', headerMeta = {}) {
    const riskFlags = [];

    if (flags.isVPN) riskFlags.push('vpn');
    if (flags.isProxy) riskFlags.push('proxy');
    if (flags.isTOR) riskFlags.push('tor');
    if (flags.hosting) riskFlags.push('hosting');
    if (lookupStatus === 'lookup_failed') riskFlags.push('lookup_failed');
    if (lookupStatus === 'ip_unknown') riskFlags.push('ip_unknown');
    if (lookupStatus === 'lookup_disabled') riskFlags.push('lookup_disabled');
    if (headerMeta.spoofSuspected) riskFlags.push('spoofed_header');

    for (const flag of headerMeta.spoofFlags || []) {
        riskFlags.push(flag);
    }

    return Array.from(new Set(riskFlags));
}

function computeRisk(info = {}) {
    let risk = 0;

    if (info.isProxy) risk += 35;
    if (info.isVPN) risk += 35;
    if (info.isTOR) risk += 55;
    if (info.hosting) risk += 25;
    if (info.lookupStatus === 'lookup_failed') risk += 10;
    if (info.lookupStatus === 'ip_unknown') risk += 20;

    return Math.min(100, risk);
}

function makeUnknownIpInfo({ trustedIp, headerMeta }) {
    const riskFlags = buildRiskFlags({}, 'ip_unknown', headerMeta);

    return {
        encryptedRawIp: null,
        ipHash: null,

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

        riskScore: 20,
        riskFlags,

        lookupProvider: 'local',
        lookupStatus: 'ip_unknown',
        lookupMessage: 'Unable to determine trusted public client IP',
        lookupRaw: compactLookupRaw({
            provider: 'local',
            status: 'ip_unknown',
            message: 'Unable to determine trusted public client IP'
        }),

        ipSource: trustedIp.source || 'unknown',
        headerIps: headerMeta.headerIps,
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

    const flags = normalizeRiskFlags(lookup);
    const riskFlags = buildRiskFlags(flags, lookup.status || 'unknown', headerMeta);

    const riskScore = computeRisk({
        ...flags,
        lookupStatus: lookup.status || 'unknown'
    });

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

        riskScore,
        riskFlags,

        lookupProvider: lookup.provider || 'unknown',
        lookupStatus: lookup.status || 'unknown',
        lookupMessage: lookup.message ? String(lookup.message).slice(0, 200) : null,
        lookupRaw: compactLookupRaw(lookup),

        ipSource: trustedIp.source,
        headerIps:
headerMeta.headerIps,
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
    isPrivateIP,
    extractDevice,
    processIP
};
