const router = require('express').Router();
const ADMIN_GUILDS_SESSION_MAX = Math.max(
    20,
    Number(process.env.ADMIN_GUILDS_SESSION_MAX || 200) || 200
);

function safeString(value, max = 120) {
    return String(value || '').replace(/[\u0000-\u001F\u007F]/g, '').slice(0, max);
}

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

function normalizeGuild(guild = {}) {
    const owner = !!guild.owner || !!guild.isOwner;
    const isAdmin = owner || guild.isAdmin === true;
    const canManageGuild = owner || isAdmin;
    const canManageRoles = owner || isAdmin;
    const canManage = owner || isAdmin;
    return {
        id: safeString(guild.id, 40),
        name: safeString(guild.name || 'Unknown Server', 120),
        icon: guild.icon ? safeString(guild.icon, 120) : null,
        owner,
        isOwner: owner,
        permissions: safeString(guild.permissions || '0', 40),
        isAdmin,
        canManage,
        canManageGuild,
        canManageRoles
    };
}

function mergeGuildPermissions(a = {}, b = {}) {
    const owner = !!a.owner || !!a.isOwner || !!b.owner || !!b.isOwner;
    const isAdmin = owner || a.isAdmin === true || b.isAdmin === true;
    const canManageGuild = owner || isAdmin;
    const canManageRoles = owner || isAdmin;
    const canManage = owner || isAdmin;
    return {
        ...a,
        ...b,
        owner,
        isOwner: owner,
        isAdmin,
        canManage,
        canManageGuild,
        canManageRoles
    };
}

function dedupeGuilds(guilds = []) {
    const map = new Map();

    for (const rawGuild of guilds.slice(0, ADMIN_GUILDS_SESSION_MAX * 2)) {
        const guild = normalizeGuild(rawGuild);
        if (!guild.id) continue;

        const existing = map.get(guild.id);

        if (!existing) {
            map.set(guild.id, guild);
            continue;
        }

        map.set(guild.id, mergeGuildPermissions(existing, guild));
    }

    return Array.from(map.values()).slice(0, ADMIN_GUILDS_SESSION_MAX);
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

    let merged = [];

    if (sessionGuilds) merged = merged.concat(sessionGuilds);
    if (userGuilds) merged = merged.concat(userGuilds);

    merged = dedupeGuilds(merged);

    req.session.adminGuilds = merged;
    adminUser.adminGuilds = merged;
}

router.use((req, _res, next) => {
    normalizeAdminUserId(req.session?.adminUser);
    normalizeAdminGuilds(req);
    next();
});

module.exports = router;
module.exports._internals = {
    ADMIN_GUILDS_SESSION_MAX,
    dedupeGuilds,
    mergeGuildPermissions,
    normalizeGuild
};
