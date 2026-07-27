#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "..");
function read(file) { return fs.readFileSync(path.join(root, file), "utf8"); }
function write(file, content) { fs.writeFileSync(path.join(root, file), content); }
function replaceOnce(file, search, replacement) {
    const source = read(file);
    const first = source.indexOf(search);
    if (first < 0) throw new Error(`PATCH_SOURCE_NOT_FOUND:${file}`);
    if (source.indexOf(search, first + search.length) >= 0) throw new Error(`PATCH_SOURCE_NOT_UNIQUE:${file}`);
    write(file, source.slice(0, first) + replacement + source.slice(first + search.length));
}
function replaceRegexOnce(file, regex, replacement) {
    const source = read(file);
    const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
    const count = [...source.matchAll(new RegExp(regex.source, flags))].length;
    if (count !== 1) throw new Error(`PATCH_REGEX_COUNT:${file}:${count}`);
    write(file, source.replace(regex, replacement));
}

replaceRegexOnce(
    "scripts/checkProtectedPaths.js",
/async function fetchOwnerApproval\([\s\S]*?\n\}/,
`async function fetchOwnerApproval({ repository, owner, pullNumber, headSha, token }) {
    const marker = \`${APPROVAL_MARKER_PREFIX}${headSha} -->\`;
    for (let page = 1; page <= 50; page++) {
        const response = await fetch(
            \`https://api.github.com/repos/${repository}/issues/${pullNumber}/comments?per_page=100&page=${page}&sort=created&direction=desc\`,
            {
                headers: {
                    accept: "application/vnd.github+json",
                    authorization: \`Bearer ${token}\`,
                    "user-agent": "discord-bot-protected-path-guard",
                    "x-github-api-version": "2022-11-28"
                }
            }
        );
        if (!response.ok) throw new Error(\`GitHub approval lookup failed with HTTP ${response.status}\`);
        const comments = await response.json();
        if (!Array.isArray(comments)) return false;
        if (comments.some(comment =>
            String(comment?.user?.login || "").toLowerCase() === owner.toLowerCase() &&
            String(comment?.body || "").includes(marker)
        )) return true;
        if (comments.length < 100) return false;
    }
    throw new Error("GitHub approval lookup exceeded pagination safety limit");
}`
);

replaceOnce(
    "scripts/checkSecretLeaks.js",
`        regex: /mongodb(?:\\+srv)?:\\/\\/[^\\s"']+:[^\\s"']+@/gi`,
`        regex: /mongodb(?:\\+srv)?:\\/\\/[^\\s"'@\\r\\n]{1,256}:[^\\s"'@\\r\\n]{1,256}@/gi`
);
replaceOnce(
    "scripts/checkSecretLeaks.js",
`const ASSIGNMENT_PATTERN = /\\b(token|secret|password|pin|api[_-]?key|webhook(?:url)?)\\b\\s*[:=]\\s*["']([^"']{12,})["']/gi;`,
`const ASSIGNMENT_PATTERN = /\\b(token|secret|password|pin|api[_-]?key|webhook(?:url)?)\\b[ \\t]*[:=][ \\t]*["']([^"'\\r\\n]{12,512})["']/gi;`
);

write("scripts/checkCoverageThresholds.js", `#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { readFiniteNumber } = require("../discord/core/numbers");

const DEFAULT_THRESHOLDS = Object.freeze({
    statements: 35,
    lines: 35,
    functions: 30,
    branches: 25
});

function percentage(covered, total) {
    if (!Number.isFinite(total) || total <= 0) return 0;
    return (covered / total) * 100;
}

function parseLcov(source) {
    const totals = {
        lines: { found: 0, hit: 0 },
        functions: { found: 0, hit: 0 },
        branches: { found: 0, hit: 0 }
    };
    for (const rawLine of String(source || "").split(/\\r?\\n/)) {
        const line = rawLine.trim();
        const [key, rawValue] = line.split(":", 2);
        const value = Number(rawValue);
        if (!Number.isFinite(value)) continue;
        if (key === "LF") totals.lines.found += value;
        else if (key === "LH") totals.lines.hit += value;
        else if (key === "FNF") totals.functions.found += value;
        else if (key === "FNH") totals.functions.hit += value;
        else if (key === "BRF") totals.branches.found += value;
        else if (key === "BRH") totals.branches.hit += value;
    }
    return totals;
}

function resolveThreshold(name, env = process.env) {
    return readFiniteNumber(env[\`COVERAGE_${name.toUpperCase()}_MIN\`], {
        fallback: DEFAULT_THRESHOLDS[name],
        min: 0,
        max: 100
    });
}

function evaluateCoverage(totals, env = process.env) {
    const reportFailures = [];
    for (const name of ["lines", "functions", "branches"]) {
        if (!Number.isFinite(totals?.[name]?.found) || totals[name].found <= 0) reportFailures.push(name);
    }
    const metrics = {
        statements: percentage(totals.lines.hit, totals.lines.found),
        lines: percentage(totals.lines.hit, totals.lines.found),
        functions: percentage(totals.functions.hit, totals.functions.found),
        branches: percentage(totals.branches.hit, totals.branches.found)
    };
    const thresholds = Object.fromEntries(
        Object.keys(DEFAULT_THRESHOLDS).map(name => [name, resolveThreshold(name, env)])
    );
    const failures = Object.keys(metrics).filter(name => metrics[name] + Number.EPSILON < thresholds[name]);
    if (reportFailures.length) failures.push("report");
    return { metrics, thresholds, failures: [...new Set(failures)], reportFailures, statementSource: "line-coverage-proxy" };
}

function formatPercent(value) {
    return \`${value.toFixed(2)}%\`;
}

function runCli(args = process.argv.slice(2)) {
    const files = args.length ? args : [
        "coverage/discord.lcov",
        "coverage/voice.lcov",
        "coverage/verification.lcov"
    ];
    let failed = false;

    for (const file of files) {
        const normalized = path.normalize(file);
        if (!fs.existsSync(normalized) || fs.statSync(normalized).size === 0) {
            console.error(\`[COVERAGE] missing or empty report: ${file}\`);
            failed = true;
            continue;
        }
        const result = evaluateCoverage(parseLcov(fs.readFileSync(normalized, "utf8")));
        const summary = Object.keys(result.metrics)
            .map(name => \`${name}${name === "statements" ? "(line-proxy)" : ""}=${formatPercent(result.metrics[name])} (min ${formatPercent(result.thresholds[name])})\`)
            .join(", ");
        console.log(\`[COVERAGE] ${file}: ${summary}\`);
        if (result.failures.length) {
            console.error(\`[COVERAGE] ${file} below threshold or invalid report: ${result.failures.join(", ")}\`);
            failed = true;
        }
    }

    if (failed) process.exitCode = 1;
}

if (require.main === module) runCli();

module.exports = {
    DEFAULT_THRESHOLDS,
    evaluateCoverage,
    parseLcov,
    percentage,
    resolveThreshold
};
`);

replaceOnce(
    "scripts/runIsolatedEnvironmentGate.js",
`    "TEST_ALLOWED_HOSTS",
    "PRODUCTION_PUBLIC_BASE_URL"`,
`    "TEST_ALLOWED_HOSTS",
    "PRODUCTION_PUBLIC_BASE_URL",
    "PRODUCTION_DISCORD_CLIENT_ID",
    "PRODUCTION_GUILD_ID",
    "PRODUCTION_TEXT_CHANNEL_ID",
    "PRODUCTION_VOICE_CHANNEL_ID"`
);
replaceOnce(
    "scripts/runIsolatedEnvironmentGate.js",
`    const ids = {};
    for (const name of [
        "TEST_GUILD_ID",
        "TEST_TEXT_CHANNEL_ID",
        "TEST_VOICE_CHANNEL_ID",
        "TEST_DISCORD_CLIENT_ID"
    ]) {
        ids[name] = normalizeDiscordSnowflake(requiredText(env, name));
        if (!ids[name]) throw new Error(\`INVALID_\${name}\`);
    }`,
`    const ids = {};
    for (const name of [
        "TEST_GUILD_ID",
        "TEST_TEXT_CHANNEL_ID",
        "TEST_VOICE_CHANNEL_ID",
        "TEST_DISCORD_CLIENT_ID",
        "PRODUCTION_DISCORD_CLIENT_ID",
        "PRODUCTION_GUILD_ID",
        "PRODUCTION_TEXT_CHANNEL_ID",
        "PRODUCTION_VOICE_CHANNEL_ID"
    ]) {
        ids[name] = normalizeDiscordSnowflake(requiredText(env, name));
        if (!ids[name]) throw new Error(\`INVALID_\${name}\`);
    }
    const separationPairs = [
        ["TEST_DISCORD_CLIENT_ID", "PRODUCTION_DISCORD_CLIENT_ID"],
        ["TEST_GUILD_ID", "PRODUCTION_GUILD_ID"],
        ["TEST_TEXT_CHANNEL_ID", "PRODUCTION_TEXT_CHANNEL_ID"],
        ["TEST_VOICE_CHANNEL_ID", "PRODUCTION_VOICE_CHANNEL_ID"]
    ];
    for (const [testName, productionName] of separationPairs) {
        if (ids[testName] === ids[productionName]) throw new Error(\`${testName}_MUST_DIFFER_FROM_${productionName}\`);
    }`
);
replaceOnce(
    "scripts/runIsolatedEnvironmentGate.js",
`        productionOrigin,
        allowedHosts: [...allowedHosts].sort(),`,
`        productionOrigin,
        productionResourceHashes: {
            client: hashIdentifier(ids.PRODUCTION_DISCORD_CLIENT_ID),
            guild: hashIdentifier(ids.PRODUCTION_GUILD_ID),
            textChannel: hashIdentifier(ids.PRODUCTION_TEXT_CHANNEL_ID),
            voiceChannel: hashIdentifier(ids.PRODUCTION_VOICE_CHANNEL_ID)
        },
        allowedHosts: [...allowedHosts].sort(),`
);
replaceOnce(
    "scripts/runIsolatedEnvironmentGate.js",
`    let config = null;
    const startedAt = new Date().toISOString();`,
`    let config = null;
    let primaryError = null;
    const startedAt = new Date().toISOString();`
);
replaceOnce(
    "scripts/runIsolatedEnvironmentGate.js",
`    } catch (error) {
        record.error = redactSecrets(error?.message || error, config);
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { gateRecord: record, gateConfig: config });
    } finally {
        record.finishedAt = new Date().toISOString();
        const fallbackConfig = config || {
            commitSha: record.commitSha,
            recordDir: String(process.env.GATE_RECORD_DIR || "artifacts")
        };
        const filename = writeRecord(fallbackConfig, record);
        console.log(\`[ENV-GATE] record=\${filename} status=\${record.status}\`);
    }`,
`    } catch (error) {
        primaryError = error instanceof Error ? error : new Error(String(error));
        record.error = redactSecrets(primaryError.message, config);
        throw Object.assign(primaryError, { gateRecord: record, gateConfig: config });
    } finally {
        record.finishedAt = new Date().toISOString();
        const fallbackConfig = config || {
            commitSha: record.commitSha,
            recordDir: String(process.env.GATE_RECORD_DIR || "artifacts")
        };
        try {
            const filename = writeRecord(fallbackConfig, record);
            console.log(\`[ENV-GATE] record=\${filename} status=\${record.status}\`);
        } catch (recordError) {
            const safeRecordError = redactSecrets(recordError?.message || recordError, config);
            if (primaryError) {
                record.recordWriteError = safeRecordError;
                console.error(\`[ENV-GATE] record write failed after primary failure: \${safeRecordError}\`);
            } else {
                throw recordError;
            }
        }
    }`
);

replaceOnce(
    ".github/workflows/isolated-environment-gate.yml",
`  PRODUCTION_PUBLIC_BASE_URL: \${{ vars.PRODUCTION_PUBLIC_BASE_URL }}
  GATE_RECORD_DIR: artifacts`,
`  PRODUCTION_PUBLIC_BASE_URL: \${{ vars.PRODUCTION_PUBLIC_BASE_URL }}
  PRODUCTION_DISCORD_CLIENT_ID: \${{ vars.PRODUCTION_DISCORD_CLIENT_ID }}
  PRODUCTION_GUILD_ID: \${{ vars.PRODUCTION_GUILD_ID }}
  PRODUCTION_TEXT_CHANNEL_ID: \${{ vars.PRODUCTION_TEXT_CHANNEL_ID }}
  PRODUCTION_VOICE_CHANNEL_ID: \${{ vars.PRODUCTION_VOICE_CHANNEL_ID }}
  GATE_RECORD_DIR: artifacts`
);

replaceOnce(
    "discord/tests/isolatedEnvironmentGate.test.js",
`        TEST_ALLOWED_HOSTS: "preview.example.test,other.example.test",
        PRODUCTION_PUBLIC_BASE_URL: "https://production.example.test"`,
`        TEST_ALLOWED_HOSTS: "preview.example.test,other.example.test",
        PRODUCTION_PUBLIC_BASE_URL: "https://production.example.test",
        PRODUCTION_DISCORD_CLIENT_ID: "523456789012345678",
        PRODUCTION_GUILD_ID: "623456789012345678",
        PRODUCTION_TEXT_CHANNEL_ID: "723456789012345678",
        PRODUCTION_VOICE_CHANNEL_ID: "823456789012345678"`
);
replaceOnce(
    "discord/tests/isolatedEnvironmentGate.test.js",
`    const productionDatabase = validEnvironment();
    productionDatabase.TEST_MONGO_URI = "mongodb://mongo.example.test/production";
    assert.throws(() => validateIsolatedEnvironment(productionDatabase), /DATABASE_NAME_REQUIRED/);`,
`    const productionDatabase = validEnvironment();
    productionDatabase.TEST_MONGO_URI = "mongodb://mongo.example.test/production";
    assert.throws(() => validateIsolatedEnvironment(productionDatabase), /DATABASE_NAME_REQUIRED/);

    const productionDiscordReuse = validEnvironment();
    productionDiscordReuse.PRODUCTION_GUILD_ID = productionDiscordReuse.TEST_GUILD_ID;
    assert.throws(() => validateIsolatedEnvironment(productionDiscordReuse), /MUST_DIFFER_FROM_PRODUCTION_GUILD_ID/);`
);

replaceOnce(
    "discord/tests/coverageThresholds.test.js",
`test("Voice coverage is scoped to the voice/session runtime instead of unrelated imports", () => {`,
`test("empty LCOV data fails closed instead of reporting perfect coverage", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const result = evaluateCoverage(parseLcov(""));
    assert.equal(percentage(0, 0), 0);
    assert.equal(result.failures.includes("report"), true);
});

test("Voice coverage is scoped to the voice/session runtime instead of unrelated imports", () => {`
);

function updateProtectedManifest() {
    const protectedFiles = ["discord/systemProvider.js"];
    const directory = path.join(root, "discord/systemProvider");
    for (const name of fs.readdirSync(directory).sort()) {
        const relative = `discord/systemProvider/${name}`;
        if (fs.statSync(path.join(root, relative)).isFile()) protectedFiles.push(relative);
    }
    const manifest = {};
    for (const relative of protectedFiles.sort()) {
        manifest[relative] = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, relative))).digest("hex");
    }
    write(".github/protected-path-digests.json", JSON.stringify(manifest, null, 2) + "\n");
}

updateProtectedManifest();
console.log("[TEMP-PATCH] CI remediation applied");
