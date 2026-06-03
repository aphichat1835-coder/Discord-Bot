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

function normalizeGuild(guild = {}) {
    const owner = !!guild.owner || !!guild.isOwner;

    return {
        ...guild,

        id: String(guild.id || ''),
        name: String(guild.name || 'Unknown Server'),
        icon: guild.icon || null,

        owner,
        isOwner: owner,

        permissions: String(guild.permissions || '0'),

        isAdmin: guild.isAdmin !== undefined
            ? !!guild.isAdmin
            : !!guild.canManage || owner,

        canManage: guild.canManage !== undefined
            ? !!guild.canManage
            : !!guild.isAdmin || owner,

        canManageGuild: guild.canManageGuild !== undefined
            ? !!guild.canManageGuild
            : !!guild.canManage || !!guild.isAdmin || owner,

        canManageRoles: guild.canManageRoles !== undefined
            ? !!guild.canManageRoles
            : !!guild.canManage || !!guild.isAdmin || owner
    };
}

function dedupeGuilds(guilds = []) {
    const map = new Map();

    for (const rawGuild of guilds) {
        const guild = normalizeGuild(rawGuild);
        if (!guild.id) continue;

        const existing = map.get(guild.id);

        if (!existing) {
            map.set(guild.id, guild);
            continue;
        }

        map.set(guild.id, {
            ...existing,
            ...guild,

            owner: existing.owner || guild.owner,
            isOwner: existing.isOwner || guild.isOwner,
            isAdmin: existing.isAdmin || guild.isAdmin,
            canManage: existing.canManage || guild.canManage,
            canManageGuild: existing.canManageGuild || guild.canManageGuild,
            canManageRoles: existing.canManageRoles || guild.canManageRoles
        });
    }

    return Array.from(map.values());
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
