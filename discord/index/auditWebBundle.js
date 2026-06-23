const { registerAuditApiRoutes } = require("./auditApiRoutes");
const { buildAuditDashboardPage } = require("./auditDashboardPage");

function registerAuditWebBundle({ app, express, sessionManager, client, auditLogger, checkAuth }) {
    registerAuditApiRoutes({ app, express, sessionManager, client, auditLogger, checkAuth });

    app.get("/audit-logs", (req, res) => {
        if (!checkAuth(req, res)) return;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(buildAuditDashboardPage());
    });

    return true;
}

module.exports = {
    registerAuditWebBundle
};
