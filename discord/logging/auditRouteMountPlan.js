const AUDIT_ROUTES = Object.freeze([
    "/audit-logs",
    "/api/audit/logs",
    "/api/audit/export",
    "/api/audit/health",
    "/api/audit/dead-letters",
    "/api/audit/settings"
]);

function buildAuditRouteMountPlan() {
    return {
        serverModule: "discord/index/server.js",
        patchDoc: "docs/AUDIT_SERVER_INTEGRATION_PATCH.md",
        routes: [...AUDIT_ROUTES]
    };
}

module.exports = {
    AUDIT_ROUTES,
    buildAuditRouteMountPlan
};
