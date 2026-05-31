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
        firstHeaderValue(req.headers['x-real-ip']) ||
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

function extractDevice(req) {
    const ua = req.headers['user-agent'] || '';
    const body = req.body || {};
    let platform = body.platform || 'Unknown';
    if (!body.platform) {
        if (/Android/i.test(ua)) platform = 'Android';
        else if (/iPhone|iPad/i.test(ua)) platform = 'iOS';
        else if (/Windows/i.test(ua)) platform = 'Windows';
        else if (/Mac OS X/i.test(ua)) platform = 'macOS';
        else if (/Linux/i.test(ua)) platform = 'Linux';
    }

    const browser = /Edg\//.test(ua) ? 'Edge'
        : /Chrome\//.test(ua) ? 'Chrome'
        : /Safari\//.test(ua) ? 'Safari'
        : /Firefox\//.test(ua) ? 'Firefox'
        : 'Unknown';

    const deviceType = /Mobile|Android|iPhone|iPad/i.test(ua) ? 'mobile' : 'desktop';
    const fingerprintSource = [ua, body.language || req.headers['accept-language'] || '', body.timezone || '', body.screenSize || '', platform].join('|');

    return {
        userAgent: String(ua).substring(0, 500),
        browser,
        os: platform,
        platform,
        deviceType,
        language: body.language || req.headers['accept-language']?.split(',')[0] || 'unknown',
        timezone: body.timezone || 'unknown',
        screenSize: body.screenSize || 'unknown',
        fingerprintHash: hmacValue(fingerprintSource, 'fingerprint')
    };
}

async function lookupIP(ip) {
    if (isPrivateIP(ip)) {
        return {
            status: 'local', country: 'unknown', countryCode: 'unknown', region: 'unknown', city: 'unknown',
            zip: 'unknown', lat: null, lon: null, timezone: 'unknown', isp: 'local/private', org: 'local/private', as: 'unknown',
            proxy: false, vpn: false, tor: false, hosting: false
        };
    }

    const fields = 'status,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as,proxy,hosting,query';
    const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=${fields}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Phomueangtai-Verify/1.0' } });
    if (!res.ok) throw new Error(`IP lookup failed: ${res.status}`);
    return res.json();
}

function computeRisk(info = {}) {
    let risk = 0;
    if (info.isProxy) risk += 35;
    if (info.isVPN) risk += 35;
    if (info.isTOR) risk += 50;
    if (info.hosting) risk += 20;
    return Math.min(100, risk);
}

async function processIP(req) {
    const rawIp = getRealIP(req);
    let lookup = {};
    try {
        lookup = await lookupIP(rawIp);
    } catch (err) {
        lookup = { status: 'lookup_failed', error: err.message };
    }

    const isProxy = !!lookup.proxy;
    const isVPN = !!lookup.vpn || !!lookup.hosting;
    const isTOR = !!lookup.tor;

    return {
        encryptedRawIp: encryptIP(rawIp),
        ipHash: hmacValue(rawIp, 'ip'),
        country: lookup.country || 'unknown',
        countryCode: lookup.countryCode || 'unknown',
        region: lookup.regionName || lookup.region || 'unknown',
        city: lookup.city || 'unknown',
        zip: lookup.zip || 'unknown',
        lat: typeof lookup.lat === 'number' ? lookup.lat : null,
        lon: typeof lookup.lon === 'number' ? lookup.lon : null,
        timezone: lookup.timezone || 'unknown',
        isp: lookup.isp || 'unknown',
        org: lookup.org || 'unknown',
        as: lookup.as || 'unknown',
        isProxy,
        isVPN,
        isTOR,
        hosting: !!lookup.hosting,
        riskScore: computeRisk({ isProxy, isVPN, isTOR, hosting: !!lookup.hosting }),
        lookupProvider: 'ip-api.com',
        lookupStatus: lookup.status || 'unknown',
        lookupAt: Date.now()
    };
}

module.exports = {
    getRealIP,
    normalizeIP,
    extractDevice,
    processIP
};
