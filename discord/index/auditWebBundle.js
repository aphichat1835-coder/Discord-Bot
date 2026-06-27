const auth = require("./auth");
const { registerAuditApiRoutes } = require("./auditApiRoutes");
const { buildAuditDashboardPage } = require("./auditDashboardPage");

function auditPageAuth(req, res, next) {
    if (typeof auth.requirePin === "function") {
        return auth.requirePin(req, res, next);
    }
    return next();
}

function registerAuditWebBundle({ app, express, sessionManager, client, auditLogger, checkAuth, requireCsrf }) {
    registerAuditApiRoutes({ app, express, sessionManager, client, auditLogger, checkAuth, requireCsrf });

    app.get("/audit-logs", auditPageAuth, (req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(buildAuditDashboardPage());
    });

    return true;
}

module.exports = {
    auditPageAuth,
    registerAuditWebBundle
};