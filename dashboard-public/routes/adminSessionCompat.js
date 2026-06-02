const router = require('express').Router();

/*
================================================================================
  Admin Session Compatibility Middleware

  Purpose:
  - OAuth admin callback stores manageable guilds in req.session.adminGuilds
  - Some older dashboard routes read req.session.adminUser.adminGuilds
  - This middleware keeps both shapes compatible without rewriting old routes

  Safety:
  - Does not grant new permissions
  - Only syncs data already present in the authenticated session
  - Does not expose secrets
  - Does not touch OAuth verification core
================================================================================
*/

function isArray(value) {
    return Array.isArray(value);
}

function normalizeAdminUserId(adminUser) {
    if (!adminUser || typeof adminUser !== 'object') return;

    if (!adminUser.userId && adminUser.id) {
        adminUser.userId = adminUser.id;
    }

    if (!adminUser.id && adminUser.userId) {
        adminUser.id = adminUser.userId;
    }
}

function normalizeAdminGuilds(req) {
    if (!req.session?.adminUser) return;

    const adminUser = req.session.adminUser;

    const sessionGuilds = isArray(req.session.adminGuilds)
        ? req.session.adminGuilds
        : null;

    const userGuilds = isArray(adminUser.adminGuilds)
        ? adminUser.adminGuilds
        : null;

    if (!userGuilds && sessionGuilds) {
        adminUser.adminGuilds = sessionGuilds;
    }

    if (!sessionGuilds && userGuilds) {
        req.session.adminGuilds = userGuilds;
    }

    if (!isArray(req.session.adminGuilds)) {
        req.session.adminGuilds = [];
    }

    if (!isArray(adminUser.adminGuilds)) {
        adminUser.adminGuilds = req.session.adminGuilds;
    }
}

router.use((req, _res, next) => {
    normalizeAdminUserId(req.session?.adminUser);
    normalizeAdminGuilds(req);
    next();
});

module.exports = router;
