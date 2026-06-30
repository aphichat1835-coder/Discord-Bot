'use strict';

/**
 * Tests for the logic changed in dashboard-public/routes/adminSessionCompat.js
 *
 * The PR refactored:
 *   - normalizeGuild()        – permissions now derived from owner/isAdmin flags only
 *   - mergeGuildPermissions() – new function replacing inline merge logic in dedupeGuilds
 *   - dedupeGuilds()          – now uses mergeGuildPermissions
 *
 * Because these functions are NOT exported from the router module we inline
 * equivalent implementations here and verify the intended logic contract.
 *
 * The inline logic below is a direct copy from the PR version of the file.
 */

// ---------------------------------------------------------------------------
// Inline the pure functions under test (copied from the PR)
// ---------------------------------------------------------------------------

const ADMIN_GUILDS_SESSION_MAX = 200;

function safeString(value, max = 120) {
    return String(value || '').replace(/[\u0000-\u001F\u007F]/g, '').slice(0, max);
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

// ---------------------------------------------------------------------------
// normalizeGuild()
// ---------------------------------------------------------------------------
describe('normalizeGuild', () => {
    test('returns sensible defaults for empty object', () => {
        const result = normalizeGuild({});
        expect(result.id).toBe('');
        expect(result.name).toBe('Unknown Server');
        expect(result.icon).toBeNull();
        expect(result.owner).toBe(false);
        expect(result.isOwner).toBe(false);
        expect(result.permissions).toBe('0');
        expect(result.isAdmin).toBe(false);
        expect(result.canManage).toBe(false);
        expect(result.canManageGuild).toBe(false);
        expect(result.canManageRoles).toBe(false);
    });

    test('sets owner and isOwner from guild.owner = true', () => {
        const result = normalizeGuild({ id: '1', owner: true });
        expect(result.owner).toBe(true);
        expect(result.isOwner).toBe(true);
    });

    test('sets owner and isOwner from guild.isOwner = true', () => {
        const result = normalizeGuild({ id: '1', isOwner: true });
        expect(result.owner).toBe(true);
        expect(result.isOwner).toBe(true);
    });

    test('owner = true implies isAdmin = true', () => {
        const result = normalizeGuild({ id: '1', owner: true });
        expect(result.isAdmin).toBe(true);
    });

    test('isAdmin = true (non-owner) sets admin/canManage flags', () => {
        const result = normalizeGuild({ id: '1', owner: false, isAdmin: true });
        expect(result.isAdmin).toBe(true);
        expect(result.canManage).toBe(true);
        expect(result.canManageGuild).toBe(true);
        expect(result.canManageRoles).toBe(true);
    });

    test('isAdmin = false does NOT grant admin access', () => {
        const result = normalizeGuild({ id: '1', owner: false, isAdmin: false });
        expect(result.isAdmin).toBe(false);
        expect(result.canManage).toBe(false);
    });

    test('preserves id as string', () => {
        expect(normalizeGuild({ id: 123456 }).id).toBe('123456');
        expect(normalizeGuild({ id: '987654321' }).id).toBe('987654321');
    });

    test('preserves name correctly', () => {
        const result = normalizeGuild({ id: '1', name: 'My Server' });
        expect(result.name).toBe('My Server');
    });

    test('preserves icon correctly', () => {
        const result = normalizeGuild({ id: '1', icon: 'abc123' });
        expect(result.icon).toBe('abc123');
    });

    test('icon null when not provided', () => {
        const result = normalizeGuild({ id: '1' });
        expect(result.icon).toBeNull();
    });

    test('drops extra fields so session payload stays compact', () => {
        const result = normalizeGuild({ id: '1', customField: 'hello' });
        expect(result.customField).toBeUndefined();
    });

    test('permissions coerced to string', () => {
        const result = normalizeGuild({ id: '1', permissions: 8 });
        expect(result.permissions).toBe('8');
    });

    // Regression: isAdmin truthy (but not === true) should NOT grant admin
    test('isAdmin truthy non-true value does not grant admin without owner', () => {
        const result = normalizeGuild({ id: '1', owner: false, isAdmin: 1 });
        // isAdmin: owner || guild.isAdmin === true → false || 1 === true → false || false → false
        expect(result.isAdmin).toBe(false);
        expect(result.canManage).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// mergeGuildPermissions()
// ---------------------------------------------------------------------------
describe('mergeGuildPermissions', () => {
    test('returns defaults for two empty objects', () => {
        const result = mergeGuildPermissions({}, {});
        expect(result.owner).toBe(false);
        expect(result.isOwner).toBe(false);
        expect(result.isAdmin).toBe(false);
        expect(result.canManage).toBe(false);
        expect(result.canManageGuild).toBe(false);
        expect(result.canManageRoles).toBe(false);
    });

    test('owner from first object propagates', () => {
        const result = mergeGuildPermissions({ owner: true }, {});
        expect(result.owner).toBe(true);
        expect(result.isAdmin).toBe(true);
        expect(result.canManage).toBe(true);
    });

    test('owner from second object propagates', () => {
        const result = mergeGuildPermissions({}, { owner: true });
        expect(result.owner).toBe(true);
        expect(result.isAdmin).toBe(true);
    });

    test('isOwner from first object treated as owner', () => {
        const result = mergeGuildPermissions({ isOwner: true }, {});
        expect(result.owner).toBe(true);
    });

    test('isAdmin from either object propagates', () => {
        const r1 = mergeGuildPermissions({ isAdmin: true }, {});
        expect(r1.isAdmin).toBe(true);
        expect(r1.canManage).toBe(true);

        const r2 = mergeGuildPermissions({}, { isAdmin: true });
        expect(r2.isAdmin).toBe(true);
        expect(r2.canManage).toBe(true);
    });

    test('spreads properties from both, b overwrites a for non-permission fields', () => {
        const a = { id: '1', name: 'Old Name', isAdmin: false };
        const b = { id: '1', name: 'New Name', isAdmin: true };
        const result = mergeGuildPermissions(a, b);
        expect(result.name).toBe('New Name'); // b overwrites a
        expect(result.isAdmin).toBe(true);    // re-computed from b.isAdmin = true
    });

    test('neither object having owner keeps owner false', () => {
        const result = mergeGuildPermissions({ isAdmin: false }, { isAdmin: false });
        expect(result.owner).toBe(false);
        expect(result.isAdmin).toBe(false);
    });

    // Regression: ensure isAdmin truthy (not strictly true) from b does not propagate
    test('isAdmin truthy non-boolean from b does not grant admin without owner', () => {
        const result = mergeGuildPermissions({}, { isAdmin: 1 });
        // isAdmin: owner || a.isAdmin === true || b.isAdmin === true
        // → false || false || (1 === true) → false
        expect(result.isAdmin).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// dedupeGuilds()
// ---------------------------------------------------------------------------
describe('dedupeGuilds', () => {
    test('returns empty array for empty input', () => {
        expect(dedupeGuilds([])).toEqual([]);
    });

    test('returns empty array for undefined input (uses default parameter)', () => {
        // Passing undefined uses the default = [] parameter
        expect(dedupeGuilds(undefined)).toEqual([]);
    });

    test('deduplicates guilds with the same id', () => {
        const guilds = [
            { id: '100', name: 'Server A', owner: false, isAdmin: false },
            { id: '100', name: 'Server A', owner: false, isAdmin: true }
        ];
        const result = dedupeGuilds(guilds);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('100');
        expect(result[0].isAdmin).toBe(true); // merged from second entry
    });

    test('keeps distinct guilds separate', () => {
        const guilds = [
            { id: '100', name: 'Server A' },
            { id: '200', name: 'Server B' }
        ];
        const result = dedupeGuilds(guilds);
        expect(result).toHaveLength(2);
        expect(result.map(g => g.id).sort()).toEqual(['100', '200']);
    });

    test('skips guilds with no id', () => {
        const guilds = [
            { name: 'No ID' },
            { id: '100', name: 'Has ID' }
        ];
        const result = dedupeGuilds(guilds);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('100');
    });

    test('merges owner flag across duplicate entries', () => {
        const guilds = [
            { id: '100', owner: false, isAdmin: false },
            { id: '100', owner: true, isAdmin: false }
        ];
        const result = dedupeGuilds(guilds);
        expect(result[0].owner).toBe(true);
        expect(result[0].isAdmin).toBe(true);
        expect(result[0].canManage).toBe(true);
    });

    test('merges isAdmin across duplicate entries', () => {
        const guilds = [
            { id: '100', owner: false, isAdmin: false },
            { id: '100', owner: false, isAdmin: true }
        ];
        const result = dedupeGuilds(guilds);
        expect(result[0].isAdmin).toBe(true);
        expect(result[0].canManage).toBe(true);
    });

    test('handles three entries for same guild, accumulating permissions', () => {
        const guilds = [
            { id: '100', owner: false, isAdmin: false },
            { id: '100', owner: false, isAdmin: false },
            { id: '100', owner: true, isAdmin: false }
        ];
        const result = dedupeGuilds(guilds);
        expect(result).toHaveLength(1);
        expect(result[0].owner).toBe(true);
        expect(result[0].isAdmin).toBe(true);
    });

    test('normalizes guild before inserting into map', () => {
        const guilds = [{ id: 100, owner: true }]; // numeric id
        const result = dedupeGuilds(guilds);
        expect(result[0].id).toBe('100'); // coerced to string
        expect(result[0].owner).toBe(true);
    });

    // Regression: merging should not lose other fields like name/icon
    test('merge preserves non-permission fields from later entry', () => {
        const guilds = [
            { id: '100', name: 'Old Name', icon: null },
            { id: '100', name: 'New Name', icon: 'hash123' }
        ];
        const result = dedupeGuilds(guilds);
        expect(result[0].name).toBe('New Name');
        expect(result[0].icon).toBe('hash123');
    });

    test('caps normalized guilds to keep admin session payload bounded', () => {
        const guilds = Array.from({ length: ADMIN_GUILDS_SESSION_MAX + 25 }, (_, idx) => ({
            id: String(100000 + idx),
            name: `Server ${idx}`,
            snapshot: { large: 'not stored' }
        }));
        const result = dedupeGuilds(guilds);
        expect(result).toHaveLength(ADMIN_GUILDS_SESSION_MAX);
        expect(result[0].snapshot).toBeUndefined();
    });
});
