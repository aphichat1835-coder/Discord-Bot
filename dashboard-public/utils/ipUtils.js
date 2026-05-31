const net = require('net');
const crypto = require('crypto');
const { encryptIP } = require('./crypto');

function hmacValue(value, prefix = 'value') {
    if (value === undefined || value === null || value === '') return null;

    const key = crypto.createHash('sha256')
        .update(`${process.env.ENCRYPTION_KEY || 'missing'}:${process.env.API_SECRET || process.env.INTERNAL_API_SECRET || 'dashboard'}`)
        .digest();

    return crypto.createHmac('sha256', key)
        .update(`${prefix}:${String(value).trim().toLowerCase()}`)
        .digest('hex');
}

function firstHeaderValue(value) {
    if (!value) return null;
    if (Array.isArray(value)) return value[0] || null;
    return String(value).split(',')[0].trim();
}

function normalizeIP(ip) {
    if (!ip) return 'unknown';

    let value = String(ip).trim();

    if (value.startsWith('::ffff:')) value = value.slice(7);
    if (value === '::1') value = '127.0.0.1';
    if (value.includes('%')) value = value.split('%')[0];

    return value || 'unknown';
}

function getRealIP(req) {
    const ip =
        firstHeaderValue(req.headers['cf-connecting-ip']) ||
        firstHeaderValue(req.headers['true-client-ip']) ||
        firstHeaderValue(req.headers['x-real-ip']) ||
        firstHeaderValue(req.headers['x-client-ip']) ||
        firstHeaderValue(req.headers['x-forwarded-for']) ||
        req.socket?.remoteAddress ||
        req.connection?.remoteAddress ||
        req.ip ||
        'unknown';

    return normalizeIP(ip);
}

function isPrivateIP(ip) {
    if (!ip || ip === 'unknown') return true;
    if (ip === '127.0.0.1' || ip === '0.0.0.0') return true;
    if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
    if (ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) return true;

    return net.isIP(ip) === 0;
}

function parseBrowser(ua) {
    if (/Edg\//i.test(ua)) return 'Edge';
    if (/OPR\//i.test(ua)) return 'Opera';
    if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) return 'Chrome';
    if (/Firefox\//i.test(ua)) return 'Firefox';
    if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) return 'Safari';
    if (/Discord/i.test(ua)) return 'Discord WebView';
    return 'Unknown';
}

function parseOS(ua, platform) {
    if (platform && platform !== 'Unknown') return platform;
    if (/Android/i.test(ua)) return 'Android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
    if (/Windows/i.test(ua)) return 'Windows';
    if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';
    if (/Linux/i.test(ua)) return 'Linux';
    return 'Unknown';
}

function extractDevice(req) {
    const ua = req.headers['user-agent'] || '';
    const body = req.body || {};
    const platform = parseOS(ua, body.platform || 'Unknown');
    const browser = parseBrowser(ua);
    const deviceType = /Mobile|Android|iPhone|iPad|iPod/i.test(ua) ? 'mobile' : 'desktop';

    const language =
        body.language ||
        req.headers['accept-language']?.split(',')[0] ||
        'unknown';

    const timezone = body.timezone || 'unknown';
    const screenSize = body.screenSize || 'unknown';

    const fingerprintSource = [
        ua,
        language,
        timezone,
        screenSize,
        platform,
        browser,
        deviceType
    ].join('|');

    return {
        userAgent: String(ua).substring(0, 500),
        browser,
        os: platform,
        platform,
        deviceType,
        language,
        timezone,
        screenSize,
        fingerprintHash: hmacValue(fingerprintSource, 'fingerprint')
    };
}

async function lookupWithIpApi(ip) {
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

    const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=${encodeURIComponent(fields)}`;
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Phomueangtai-Verify/1.1'
        }
    });

    if (!res.ok) throw new Error(`ip-api lookup failed: ${res.status}`);

    const data = await res.json();

    if (data.status === 'fail') {
        throw new Error(data.message || 'ip-api lookup failed');
    }

    return {
        provider: 'ip-api.com',
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

    return lookupWithIpApi(ip);
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

function computeRisk(info = {}) {
    let risk = 0;

    if (info.isProxy) risk += 35;
    if (info.isVPN) risk += 35;
    if (info.isTOR) risk += 55;
    if (info.hosting) risk += 25;
    if (info.lookupStatus === 'lookup_failed') risk += 10;

    return Math.min(100, risk);
}

async function processIP(req) {
    const rawIp = getRealIP(req);
    let lookup = {};

    try {
        lookup = await lookupIP(rawIp);
    } catch (err) {
        lookup = {
            provider: 'lookup_failed',
            raw: null,
            status: 'lookup_failed',
            message: err.message,
            query: rawIp,
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

        lookupProvider: lookup.provider || 'unknown',
        lookupStatus: lookup.status || 'unknown',
        lookupMessage: lookup.message || null,
        lookupRaw: lookup.raw || null,
        lookupAt: Date.now()
    };
}

module.exports = {
    getRealIP,
    normalizeIP,
    extractDevice,
    processIP
};
