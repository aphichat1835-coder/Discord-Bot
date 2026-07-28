from pathlib import Path
import re


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def replace_once(text, old, new, label):
    count = text.count(old)
    require(count == 1, f"{label}: expected 1 target, found {count}")
    return text.replace(old, new, 1)


def replace_between(text, start_marker, end_marker, replacement, label):
    start = text.find(start_marker)
    end = text.find(end_marker, start + len(start_marker))
    require(start >= 0 and end > start, f"{label}: function boundaries not found")
    return text[:start] + replacement.rstrip() + "\n\n" + text[end:]


workflow_path = Path(".github/workflows/isolated-environment-gate.yml")
workflow = workflow_path.read_text()
workflow, changed = re.subn(
    r"(github\.event_name == 'pull_request' && github\.head_ref == 'ttt\.1') && vars\.RUN_ISOLATED_ENVIRONMENT_GATE == 'true'",
    r"\1",
    workflow,
    count=1,
)
require(changed == 1, f"isolated gate condition: expected 1 target, found {changed}")
require("RUN_ISOLATED_ENVIRONMENT_GATE" not in workflow, "isolated gate opt-out still present")
workflow_path.write_text(workflow)


gate_test_path = Path("discord/tests/isolatedEnvironmentGate.test.js")
gate_test = gate_test_path.read_text()
if 'const fs = require("node:fs");' not in gate_test:
    gate_test = replace_once(
        gate_test,
        'const assert = require("node:assert/strict");\nconst test = require("node:test");',
        'const assert = require("node:assert/strict");\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst test = require("node:test");',
        "gate test imports",
    )
if "isolated environment workflow cannot be disabled for PR 71" not in gate_test:
    gate_test += r'''

test("isolated environment workflow cannot be disabled for PR 71", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const workflow = fs.readFileSync(
        path.join(__dirname, "../../.github/workflows/isolated-environment-gate.yml"),
        "utf8"
    );
    assert.doesNotMatch(workflow, /RUN_ISOLATED_ENVIRONMENT_GATE/);
    assert.match(workflow, /github\.head_ref == ['"]ttt\.1['"]/);
    assert.match(workflow, /workflow_dispatch/);
});
'''
gate_test_path.write_text(gate_test)


utility_path = Path("discord/commands/utility.js")
utility = utility_path.read_text()
utility = replace_once(
    utility,
    "${input.overwriteStats.skippedRoleMissing + input.overwriteStats.skippedMemberMissing} ข้าม",
    "${input.overwriteStats.skippedRoleMissing + input.overwriteStats.skippedMemberMissing} หาย / ${Number(input.overwriteStats.skippedMemberUnresolved || 0)} ตรวจไม่ได้",
    "restore DM stats",
)

resolver_block = r'''const RESTORE_MEMBER_FETCH_CONCURRENCY = 4;
const RESTORE_MEMBER_FETCH_TIMEOUT_MS = 5000;

function collectRestoreMemberIds(channels) {
    const memberIds = new Set();
    for (const channelData of channels || []) {
        for (const overwrite of channelData.permissionOverwrites || []) {
            if (normalizeOverwriteType(overwrite.type) === "member") memberIds.add(overwrite.id);
        }
    }
    return [...memberIds];
}

function isMissingRestoreMemberError(error) {
    const code = Number(error?.code ?? error?.rawError?.code);
    return code === 10007 || Number(error?.status) === 404;
}

async function fetchRestoreMemberWithTimeout(guild, memberId, timeoutMs) {
    let timeout;
    try {
        return await Promise.race([
            Promise.resolve().then(() => guild.members.fetch(memberId)),
            new Promise((_, reject) => {
                timeout = setTimeout(() => {
                    const error = new Error(`RESTORE_MEMBER_FETCH_TIMEOUT:${memberId}`);
                    error.code = "RESTORE_MEMBER_FETCH_TIMEOUT";
                    reject(error);
                }, timeoutMs);
            })
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

async function resolveRestoreMemberTargets(guild, channels, options = {}) {
    const states = new Map();
    const pending = [];
    for (const memberId of collectRestoreMemberIds(channels)) {
        if (guild.members.cache.has(memberId)) states.set(memberId, "resolved");
        else pending.push(memberId);
    }

    if (pending.length === 0) return states;
    if (typeof guild.members.fetch !== "function") {
        for (const memberId of pending) states.set(memberId, "unresolved");
        return states;
    }

    const requestedConcurrency = Number(options.memberFetchConcurrency);
    const requestedTimeoutMs = Number(options.memberFetchTimeoutMs);
    const concurrency = Number.isFinite(requestedConcurrency)
        ? Math.max(1, Math.min(10, Math.trunc(requestedConcurrency)))
        : RESTORE_MEMBER_FETCH_CONCURRENCY;
    const timeoutMs = Number.isFinite(requestedTimeoutMs)
        ? Math.max(100, Math.min(30000, Math.trunc(requestedTimeoutMs)))
        : RESTORE_MEMBER_FETCH_TIMEOUT_MS;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
        while (cursor < pending.length) {
            const memberId = pending[cursor++];
            try {
                const member = await fetchRestoreMemberWithTimeout(guild, memberId, timeoutMs);
                states.set(memberId, member ? "resolved" : "missing");
            } catch (error) {
                states.set(memberId, isMissingRestoreMemberError(error) ? "missing" : "unresolved");
            }
        }
    });
    await Promise.all(workers);
    return states;
}

function resolveRestoreOverwriteTarget(guild, overwrite, roleIdMap, oldGuildId, memberTargetStates = new Map()) {
    const overwriteType = normalizeOverwriteType(overwrite.type);
    let targetId = roleIdMap.get(overwrite.id);
    if (overwrite.id === oldGuildId) targetId = guild.id;
    if (!targetId && overwriteType === "member" && guild.members.cache.has(overwrite.id)) targetId = overwrite.id;
    if (!targetId && overwriteType === "member" && memberTargetStates.get(overwrite.id) === "resolved") targetId = overwrite.id;
    if (!targetId && overwriteType === "role" && guild.roles.cache.has(overwrite.id)) targetId = overwrite.id;
    return targetId;
}

function buildResolvedOverwrites(guild, channelData, roleIdMap, oldGuildId, memberTargetStates = new Map()) {
    const stats = {
        restored: 0,
        skippedRoleMissing: 0,
        skippedMemberMissing: 0,
        skippedMemberUnresolved: 0
    };
    const overwrites = [];
    for (const overwrite of channelData.permissionOverwrites || []) {
        const overwriteType = normalizeOverwriteType(overwrite.type);
        const targetId = resolveRestoreOverwriteTarget(
            guild, overwrite, roleIdMap, oldGuildId, memberTargetStates
        );
        if (targetId) {
            stats.restored++;
            overwrites.push({
                id: targetId,
                allow: restoreBigInt(overwrite.allow),
                deny: restoreBigInt(overwrite.deny)
            });
        } else if (overwriteType === "member") {
            if (memberTargetStates.get(overwrite.id) === "unresolved") stats.skippedMemberUnresolved++;
            else stats.skippedMemberMissing++;
        } else {
            stats.skippedRoleMissing++;
        }
    }
    return { overwrites, stats };
}

function addOverwriteStats(target, source, { includeRestored = true } = {}) {
    if (includeRestored) target.restored += Number(source.restored || 0);
    target.skippedRoleMissing += Number(source.skippedRoleMissing || 0);
    target.skippedMemberMissing += Number(source.skippedMemberMissing || 0);
    target.skippedMemberUnresolved = Number(target.skippedMemberUnresolved || 0) +
        Number(source.skippedMemberUnresolved || 0);
}'''
utility = replace_between(
    utility,
    "function resolveRestoreOverwriteTarget(",
    "function planRestoreOverwrites(",
    resolver_block,
    "restore resolver functions",
)

planning_block = r'''function planRestoreOverwrites(guild, channelData, roleIdMap, oldGuildId, plan, memberTargetStates) {
    const resolved = buildResolvedOverwrites(
        guild, channelData, roleIdMap, oldGuildId, memberTargetStates
    );
    plan.overwritesRestored += resolved.stats.restored;
    plan.overwritesSkippedRoleMissing += resolved.stats.skippedRoleMissing;
    plan.overwritesSkippedMemberMissing += resolved.stats.skippedMemberMissing;
    plan.overwritesSkippedMemberUnresolved += resolved.stats.skippedMemberUnresolved;
}

function planRestoreChannel(
    guild, channelData, categoryIdMap, roleIdMap, oldGuildId, plan, memberTargetStates
) {
    if (!SUPPORTED_BACKUP_CHANNEL_TYPES.has(channelData.type)) {
        plan.channelsSkipped++;
        return;
    }
    const parentId = channelData.parentId ? categoryIdMap.get(channelData.parentId) : undefined;
    const found = findExistingChannelForRestore(guild, channelData, parentId);

    if (found.ambiguous) {
        plan.channelsAmbiguous++;
        return;
    }
    if (found.exists) {
        plan.channelsSkipped++;
        return;
    }
    plan.channelsToCreate++;
    planRestoreOverwrites(
        guild, channelData, roleIdMap, oldGuildId, plan, memberTargetStates
    );
}

async function buildRestorePlan(guild, backupData, oldGuildId, options = {}) {
    const roles = Array.isArray(backupData.roles) ? backupData.roles : [];
    const channels = normalizeSnapshotChannels(backupData.channels);
    const memberTargetStates = options.memberTargetStates instanceof Map
        ? options.memberTargetStates
        : await resolveRestoreMemberTargets(guild, channels, options);
    const roleIdMap = new Map();
    const categoryIdMap = new Map();
    const plan = {
        rolesToCreate: 0,
        rolesSkipped: 0,
        rolesAmbiguous: 0,
        channelsToCreate: 0,
        channelsSkipped: 0,
        channelsAmbiguous: 0,
        overwritesRestored: 0,
        overwritesSkippedRoleMissing: 0,
        overwritesSkippedMemberMissing: 0,
        overwritesSkippedMemberUnresolved: 0,
        warnings: []
    };

    for (const rData of roles) {
        planRestoreRole(guild, rData, roleIdMap, plan);
    }

    for (const cData of channels.filter(c => c.type === "GUILD_CATEGORY")) {
        planRestoreCategory(guild, cData, categoryIdMap, plan);
    }

    for (const cData of channels.filter(c => c.type !== "GUILD_CATEGORY")) {
        planRestoreChannel(
            guild, cData, categoryIdMap, roleIdMap, oldGuildId, plan, memberTargetStates
        );
    }

    if (plan.rolesAmbiguous || plan.channelsAmbiguous) {
        plan.warnings.push("พบชื่อซ้ำที่ต้องตรวจเองก่อน restore");
    }

    return plan;
}'''
utility = replace_between(
    utility,
    "function planRestoreOverwrites(",
    "function buildBackupCreatedEvent(",
    planning_block,
    "restore planning functions",
)

utility = replace_once(
    utility,
    "const plan = buildRestorePlan(interaction.guild, backupData, backup.guildId);",
    "const plan = await buildRestorePlan(interaction.guild, backupData, backup.guildId);",
    "await restore preview plan",
)
utility = replace_once(
    utility,
    "${plan.overwritesSkippedMemberMissing} member หาย`;",
    "${plan.overwritesSkippedMemberMissing} member หาย, ${plan.overwritesSkippedMemberUnresolved} member ตรวจไม่ได้`;",
    "restore preview member summary",
)
utility = replace_once(
    utility,
    "            const channels = normalizeSnapshotChannels(backupData.channels);\n            const oldGuildId = backup.guildId;",
    "            const channels = normalizeSnapshotChannels(backupData.channels);\n            const memberTargetStates = await resolveRestoreMemberTargets(guild, channels);\n            const oldGuildId = backup.guildId;",
    "restore execution member prefetch",
)
utility = replace_once(
    utility,
    "                skippedRoleMissing: 0,\n                skippedMemberMissing: 0\n            };",
    "                skippedRoleMissing: 0,\n                skippedMemberMissing: 0,\n                skippedMemberUnresolved: 0\n            };",
    "restore execution aggregate stats",
)
resolver_call = "buildResolvedOverwrites(guild, cData, roleIdMap, oldGuildId)"
require(utility.count(resolver_call) == 2, f"restore execution resolver calls: found {utility.count(resolver_call)}")
utility = utility.replace(
    resolver_call,
    "buildResolvedOverwrites(guild, cData, roleIdMap, oldGuildId, memberTargetStates)",
)
utility = replace_once(
    utility,
    "${overwriteStats.skippedMemberMissing} member หาย` +",
    "${overwriteStats.skippedMemberMissing} member หาย, ${overwriteStats.skippedMemberUnresolved} member ตรวจไม่ได้` +",
    "restore execution result summary",
)
utility = replace_once(
    utility,
    "overwriteStats.skippedRoleMissing + overwriteStats.skippedMemberMissing;",
    "overwriteStats.skippedRoleMissing + overwriteStats.skippedMemberMissing +\n                overwriteStats.skippedMemberUnresolved;",
    "restore completion accounting",
)
utility = replace_once(
    utility,
    "        buildRestorePlan,\n        buildResolvedOverwrites,",
    "        buildRestorePlan,\n        collectRestoreMemberIds,\n        resolveRestoreMemberTargets,\n        buildResolvedOverwrites,",
    "restore test exports",
)
require(utility.count("skippedMemberUnresolved") >= 8, "unresolved member reporting incomplete")
utility_path.write_text(utility)


backup_test_path = Path("discord/tests/backupRestore.test.js")
backup_test = backup_test_path.read_text()
backup_test = replace_once(
    backup_test,
    'test("restore planning maps numeric category parents before matching child channels", () => {',
    'test("restore planning maps numeric category parents before matching child channels", async () => {',
    "first restore plan test async",
)
backup_test = replace_once(
    backup_test,
    'test("restore planner skips existing and unsupported channels without counting unapplied overwrites", () => {',
    'test("restore planner skips existing and unsupported channels without counting unapplied overwrites", async () => {',
    "second restore plan test async",
)
plan_call = "const plan = utility._test.buildRestorePlan("
require(backup_test.count(plan_call) == 2, f"restore plan calls: expected 2, found {backup_test.count(plan_call)}")
backup_test = backup_test.replace(plan_call, "const plan = await utility._test.buildRestorePlan(")
backup_test = replace_once(
    backup_test,
    "        skippedRoleMissing: 1,\n        skippedMemberMissing: 1\n    });",
    "        skippedRoleMissing: 1,\n        skippedMemberMissing: 1,\n        skippedMemberUnresolved: 0\n    });",
    "resolved overwrite expectation",
)
backup_test = replace_once(
    backup_test,
    "    const aggregate = { restored: 0, skippedRoleMissing: 0, skippedMemberMissing: 0 };",
    "    const aggregate = {\n        restored: 0,\n        skippedRoleMissing: 0,\n        skippedMemberMissing: 0,\n        skippedMemberUnresolved: 0\n    };",
    "aggregate stats setup",
)
backup_test = replace_once(
    backup_test,
    "        restored: 0,\n        skippedRoleMissing: 1,\n        skippedMemberMissing: 1\n    });\n});",
    "        restored: 0,\n        skippedRoleMissing: 1,\n        skippedMemberMissing: 1,\n        skippedMemberUnresolved: 0\n    });\n});",
    "aggregate stats expectation",
)
backup_test += r'''

test("restore member targets fetch uncached members once and distinguish missing from unresolved", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const guildId = "111111111111111111";
    const cachedMember = "222222222222222222";
    const fetchedMember = "333333333333333333";
    const missingMember = "444444444444444444";
    const unresolvedMember = "555555555555555555";
    const fetchCalls = [];
    const guild = {
        id: guildId,
        roles: { cache: new Collection(), everyone: { id: guildId, name: "@everyone" } },
        members: {
            cache: new Collection([[cachedMember, { id: cachedMember }]]),
            async fetch(memberId) {
                fetchCalls.push(memberId);
                if (memberId === fetchedMember) return { id: memberId };
                if (memberId === missingMember) {
                    const error = new Error("Unknown Member");
                    error.code = 10007;
                    throw error;
                }
                throw new Error("network unavailable");
            }
        },
        channels: { cache: new Collection() }
    };
    const channels = [{
        id: "666666666666666666",
        name: "private",
        type: ChannelType.GuildText,
        parentId: null,
        permissionOverwrites: [
            { id: cachedMember, type: "member", allow: "1", deny: "0" },
            { id: fetchedMember, type: "member", allow: "2", deny: "0" },
            { id: fetchedMember, type: "member", allow: "4", deny: "0" },
            { id: missingMember, type: "member", allow: "8", deny: "0" },
            { id: unresolvedMember, type: "member", allow: "16", deny: "0" }
        ]
    }];

    const states = await utility._test.resolveRestoreMemberTargets(guild, channels, {
        memberFetchConcurrency: 2,
        memberFetchTimeoutMs: 1000
    });
    assert.equal(states.get(cachedMember), "resolved");
    assert.equal(states.get(fetchedMember), "resolved");
    assert.equal(states.get(missingMember), "missing");
    assert.equal(states.get(unresolvedMember), "unresolved");
    assert.deepEqual(fetchCalls.sort(), [fetchedMember, missingMember, unresolvedMember].sort());

    const resolved = utility._test.buildResolvedOverwrites(
        guild, channels[0], new Map(), guildId, states
    );
    assert.equal(resolved.overwrites.length, 3);
    assert.deepEqual(resolved.stats, {
        restored: 3,
        skippedRoleMissing: 0,
        skippedMemberMissing: 1,
        skippedMemberUnresolved: 1
    });

    const plan = await utility._test.buildRestorePlan(guild, { roles: [], channels }, guildId, {
        memberTargetStates: states
    });
    assert.equal(plan.overwritesRestored, resolved.stats.restored);
    assert.equal(plan.overwritesSkippedMemberMissing, resolved.stats.skippedMemberMissing);
    assert.equal(plan.overwritesSkippedMemberUnresolved, resolved.stats.skippedMemberUnresolved);
});
'''
backup_test_path.write_text(backup_test)
