from pathlib import Path


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def replace_once(text, old, new, label):
    count = text.count(old)
    require(count == 1, f"{label}: expected 1 target, found {count}")
    return text.replace(old, new, 1)


system_path = Path("discord/index/system.js")
system = system_path.read_text()
system = replace_once(
    system,
    """    let isShuttingDownMain = false;\n\n    async function shutdown(signal, exitCode = 0) {\n        if (isShuttingDownMain) return;\n        isShuttingDownMain = true;""",
    """    let isShuttingDownMain = false;\n    let shutdownExitCode = 0;\n\n    async function shutdown(signal, exitCode = 0) {\n        shutdownExitCode = Math.max(shutdownExitCode, Number(exitCode) || 0);\n        if (isShuttingDownMain) return;\n        isShuttingDownMain = true;""",
    "shutdown exit escalation state",
)
system = replace_once(
    system,
    "            process.exit(exitCode);",
    "            process.exit(shutdownExitCode);",
    "shutdown final exit code",
)
system_path.write_text(system)


oauth_path = Path("discord/verification/routes/oauth.js")
oauth = oauth_path.read_text()
old_oauth_start = """router.get('/auth/start', async (req, res) => {\n    res.set('Cache-Control', 'no-store');\n    const panelState = decodeCallbackState(req.query?.state);\n    if (!panelState?.guildId || !panelState?.roleId) {\n        return res.status(400).send('ลิงก์ยืนยันไม่ถูกต้อง');\n    }\n\n    const safeGuildId = safeSnowflakeStrict(panelState.guildId, \"guild_id\");\n    const guildConfig = await GuildConfig.findOne()\n        .where('guildId').equals(safeGuildId)\n        .lean();\n    const verification = normalizeVerificationConfig(guildConfig?.verification || {});\n    if (!verification.enabled || String(verification.roleId || '') !== String(panelState.roleId)) {\n        return res.status(409).send('แผงยืนยันนี้ไม่พร้อมใช้งาน');\n    }\n    if (panelState.panelRevision && verification.panelRevision &&\n        String(panelState.panelRevision) !== String(verification.panelRevision)) {\n        return res.status(409).send('แผงยืนยันนี้ถูกแทนที่แล้ว กรุณาใช้แผงล่าสุด');\n    }\n\n    const executionState = createCompactCallbackState({\n        guildId: panelState.guildId,\n        roleId: panelState.roleId,\n        expectedUserId: panelState.expectedUserId || null,\n        panelRevision: verification.panelRevision || panelState.panelRevision || null,\n        expiresAt: Date.now() + 10 * 60 * 1000\n    });\n    const executionStateObj = decodeCallbackState(executionState);\n    if (!executionStateObj || !await registerVerificationState(executionStateObj)) {\n        return res.status(503).send('ไม่สามารถเริ่มการยืนยันได้ กรุณาลองใหม่');\n    }\n\n    const params = new URLSearchParams({\n        client_id: process.env.DISCORD_CLIENT_ID,\n        redirect_uri: REDIRECT_URI,\n        response_type: 'code',\n        scope: VERIFY_SCOPE,\n        state: executionState,\n        prompt: 'consent'\n    });\n    return res.redirect(302, `https://discord.com/oauth2/authorize?${params.toString()}`);\n});"""
new_oauth_start = """router.get('/auth/start', async (req, res) => {\n    res.set('Cache-Control', 'no-store');\n    try {\n        const panelState = decodeCallbackState(req.query?.state);\n        if (!panelState?.guildId || !panelState?.roleId) {\n            return res.status(400).send('ลิงก์ยืนยันไม่ถูกต้อง');\n        }\n\n        const safeGuildId = safeSnowflakeStrict(panelState.guildId, \"guild_id\");\n        const guildConfig = await GuildConfig.findOne()\n            .where('guildId').equals(safeGuildId)\n            .lean();\n        const verification = normalizeVerificationConfig(guildConfig?.verification || {});\n        if (!verification.enabled || String(verification.roleId || '') !== String(panelState.roleId)) {\n            return res.status(409).send('แผงยืนยันนี้ไม่พร้อมใช้งาน');\n        }\n        if (panelState.panelRevision && verification.panelRevision &&\n            String(panelState.panelRevision) !== String(verification.panelRevision)) {\n            return res.status(409).send('แผงยืนยันนี้ถูกแทนที่แล้ว กรุณาใช้แผงล่าสุด');\n        }\n\n        const executionState = createCompactCallbackState({\n            guildId: panelState.guildId,\n            roleId: panelState.roleId,\n            expectedUserId: panelState.expectedUserId || null,\n            panelRevision: verification.panelRevision || panelState.panelRevision || null,\n            expiresAt: Date.now() + 10 * 60 * 1000\n        });\n        const executionStateObj = decodeCallbackState(executionState);\n        if (!executionStateObj || !await registerVerificationState(executionStateObj)) {\n            return res.status(503).send('ไม่สามารถเริ่มการยืนยันได้ กรุณาลองใหม่');\n        }\n\n        const params = new URLSearchParams({\n            client_id: process.env.DISCORD_CLIENT_ID,\n            redirect_uri: REDIRECT_URI,\n            response_type: 'code',\n            scope: VERIFY_SCOPE,\n            state: executionState,\n            prompt: 'consent'\n        });\n        return res.redirect(302, `https://discord.com/oauth2/authorize?${params.toString()}`);\n    } catch (error) {\n        const errorCode = String(error?.code || error?.name || 'oauth_start_failed').slice(0, 80);\n        console.error(`[VERIFY] auth/start failed: ${errorCode}`);\n        if (error?.code === 'invalid_snowflake') {\n            return res.status(400).send('ลิงก์ยืนยันไม่ถูกต้อง');\n        }\n        return res.status(503).send('ไม่สามารถเริ่มการยืนยันได้ กรุณาลองใหม่');\n    }\n});"""
oauth = replace_once(oauth, old_oauth_start, new_oauth_start, "OAuth start error boundary")
oauth_path.write_text(oauth)


guild_path = Path("discord/verification/routes/guild.js")
guild = guild_path.read_text()
guild = replace_once(
    guild,
    """      deletedCount: Object.values(deletion.manifest || {})\n        .filter(value => Number.isFinite(Number(value)))\n        .reduce((sum, value) => sum + Number(value), 0),""",
    """      deletedCount: Number(deletion.manifest?.deletedCount || 0),""",
    "privacy deletion response count",
)
guild_path.write_text(guild)


architecture_path = Path("ARCHITECTURE.md")
architecture = architecture_path.read_text()
architecture = replace_once(
    architecture,
    "| `GET /ready` | alias of the combined `/health` readiness response |\n| `GET /auth/callback` | serves OAuth callback UI |",
    "| `GET /ready` | alias of the combined `/health` readiness response |\n| `GET /auth/start` | validates the panel state, registers a one-time execution state, and redirects to Discord OAuth |\n| `GET /auth/callback` | serves OAuth callback UI |",
    "OAuth start architecture row",
)
architecture_path.write_text(architecture)


changelog_path = Path("CHANGELOG.md")
changelog = changelog_path.read_text()
changelog = replace_once(
    changelog,
    "## [Unreleased] - Unified Bot And Verification Runtime 2026-07-16\n\n",
    "## [Unreleased] - Unified Bot And Verification Runtime 2026-07-16\n\n- Hardened the public OAuth start route with a friendly error boundary, preserved fatal shutdown exit-code escalation during overlapping graceful shutdown, and corrected privacy-deletion response totals to use the verified manifest counter.\n\n",
    "changelog follow-up entry",
)
changelog_path.write_text(changelog)


test_path = Path("discord/tests/finalReviewContracts.test.js")
test_path.write_text(r'''"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function source(relativePath) {
    return fs.readFileSync(path.join(__dirname, "../..", relativePath), "utf8");
}

test("fatal shutdown escalates the exit code of an in-progress graceful shutdown", () => {
    const system = source("discord/index/system.js");
    assert.match(system, /let shutdownExitCode = 0;/);
    assert.match(system, /shutdownExitCode = Math\.max\(shutdownExitCode, Number\(exitCode\) \|\| 0\);/);
    assert.match(system, /process\.exit\(shutdownExitCode\);/);
});

test("OAuth start has a bounded friendly error boundary and a fixed Discord redirect", () => {
    const oauth = source("discord/verification/routes/oauth.js");
    const start = oauth.indexOf("router.get('/auth/start'");
    const end = oauth.indexOf("router.get('/auth/callback'", start);
    assert.ok(start >= 0 && end > start);
    const handler = oauth.slice(start, end);
    assert.match(handler, /try \{/);
    assert.match(handler, /catch \(error\)/);
    assert.match(handler, /res\.status\(503\)\.send\('ไม่สามารถเริ่มการยืนยันได้ กรุณาลองใหม่'\)/);
    assert.match(handler, /https:\/\/discord\.com\/oauth2\/authorize\?/);
});

test("privacy deletion response uses the verified manifest deletedCount", () => {
    const guild = source("discord/verification/routes/guild.js");
    assert.match(guild, /deletedCount: Number\(deletion\.manifest\?\.deletedCount \|\| 0\)/);
    assert.doesNotMatch(guild, /deletedCount: Object\.values\(deletion\.manifest/);
});
''')
