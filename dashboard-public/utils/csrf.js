const crypto = require('node:crypto');

const CSRF_COOKIE = 'csrf_pub';

function getCsrfSecret() {
    return process.env.SESSION_SECRET || process.env.API_SECRET || process.env.ENCRYPTION_KEY || '';
}

function makeCsrfToken(sessionId) {
    const secret = getCsrfSecret();
    if (!secret || !sessionId) return '';
    return crypto.createHmac('sha256', secret).update(`csrf:${sessionId}`).digest('hex');
}

function setCsrfCookie(req, res) {
    if (!req.session?.id) return;
    const token = makeCsrfToken(req.session.id);
    if (!token) return;
    const prod = String(process.env.NODE_ENV || '') === 'production';
    const secure = prod ? '; Secure' : '';
    res.append('Set-Cookie', `${CSRF_COOKIE}=${token}; Path=/; SameSite=Strict${secure}`);
}

function requireCsrf(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase())) return next();

    const sessionId = req.session?.id;
    const provided = String(req.headers['x-csrf-token'] || '').trim();

    if (!sessionId || !provided) {
        return res.status(403).json({ success: false, error: 'CSRF token is missing', code: 'csrf_missing' });
    }

    const expected = makeCsrfToken(sessionId);

    if (provided.length !== expected?.length) {
        return res.status(403).json({ success: false, error: 'CSRF token is invalid', code: 'csrf_invalid' });
    }

    try {
        if (!crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
            return res.status(403).json({ success: false, error: 'CSRF token is invalid', code: 'csrf_invalid' });
        }
    } catch {
        return res.status(403).json({ success: false, error: 'CSRF token is invalid', code: 'csrf_invalid' });
    }

    return next();
}

module.exports = { makeCsrfToken, setCsrfCookie, requireCsrf, CSRF_COOKIE };
