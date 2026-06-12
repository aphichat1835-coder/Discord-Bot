function applySecurityHeaders(req, res, next) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    next();
}

function createHttpApp(express, options = {}) {
    const app = express();
    const trustProxy = options.trustProxy ?? 1;
    const jsonLimit = options.jsonLimit || "64kb";
    const urlencodedLimit = options.urlencodedLimit || "64kb";

    app.set("trust proxy", trustProxy);
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
