function buildAuditRouteMountPlan() {
    return {
        serverModule: "discord/index/server.js",
        importLine: "const { registerAuditWebBundle } = require(\"./auditWebBundle\");",
        mountAfter: "const rateLimiter = createRateLimiter(requestCounts, config, sessionManager);",
        mountCall: "registerAuditWebBundle({ app, express, sessionManager, client, auditLogger, checkAuth });",
        routes: [
            "/api/audit/logs",
            "/api/audit/export",
            "/api/audit/health",
            "/audit-logs"
        ],
        notes: [
            "Mount inside registerRoutes after checkAuth exists.",
            "Do not remove existing /api auth, rate limit, reveal token, or CSRF logic.",
            "The audit routes still call checkAuth directly, so they remain protected even before deeper UI integration."
        ]
    };
}

module.exports = {
    buildAuditRouteMountPlan
};
