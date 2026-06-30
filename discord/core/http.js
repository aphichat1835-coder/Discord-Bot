function applySecurityHeaders(req, res, next) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data: https://cdn.discordapp.com; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );
    next();
}

function createHttpApp(express, options = {}) {
    const app = express();
    const jsonLimit = options.jsonLimit || "64kb";
    const urlencodedLimit = options.urlencodedLimit || "64kb";

    if (Object.hasOwn(options, "trustProxy")) {
        app.set("trust proxy", options.trustProxy);
    }

    app.disable("x-powered-by");
    app.use(applySecurityHeaders);
    app.use(express.json({ limit: jsonLimit }));
    app.use(express.urlencoded({ extended: true, limit: urlencodedLimit }));

    return app;
}

module.exports = {
    applySecurityHeaders,
    createHttpApp
};
