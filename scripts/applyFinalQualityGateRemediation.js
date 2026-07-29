#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function write(relativePath, content) {
    fs.writeFileSync(path.join(ROOT, relativePath), content, "utf8");
}

function replaceOnce(content, before, after, label) {
    const first = content.indexOf(before);
    if (first === -1) throw new Error(`Patch target not found: ${label}`);
    if (content.indexOf(before, first + before.length) !== -1) {
        throw new Error(`Patch target is ambiguous: ${label}`);
    }
    return `${content.slice(0, first)}${after}${content.slice(first + before.length)}`;
}

function patchPrivacyDeletion() {
    const file = "discord/verification/services/privacyDeletion.js";
    let content = read(file);

    content = replaceOnce(
        content,
        "    let dbSession = null;\n    let operationError = null;\n    try {",
        "    let dbSession = null;\n    let operationError = null;\n    let result = null;\n    try {",
        "privacy deletion result state"
    );

    content = replaceOnce(
        content,
        "        return { success: true, jobId, manifest, reused: false, status: \"completed\", pending: false };",
        "        result = { success: true, jobId, manifest, reused: false, status: \"completed\", pending: false };",
        "privacy deletion successful result"
    );

    content = replaceOnce(
        content,
        `        throw error;\n    } finally {\n        if (dbSession) {\n            try {\n                await dbSession.endSession();\n            } catch (endError) {\n                if (!operationError) throw endError;\n                operationError.endSessionError = endError?.message || String(endError);\n            }\n        }\n    }\n}`,
        `    }\n\n    if (dbSession) {\n        try {\n            await dbSession.endSession();\n        } catch (endError) {\n            const cleanupMessage = endError?.message || String(endError);\n            if (operationError) {\n                operationError.endSessionError = cleanupMessage;\n            } else {\n                manifest.metadata.sessionCleanupWarning = cleanupMessage;\n                await PrivacyDeletionJobModel.updateOne(\n                    { jobId, status: \"completed\" },\n                    {\n                        $set: {\n                            \"manifest.metadata.sessionCleanupWarning\": cleanupMessage,\n                            updatedAt: Date.now()\n                        }\n                    }\n                ).catch(() => {});\n            }\n        }\n    }\n\n    if (operationError) throw operationError;\n    return result;\n}`,
        "privacy deletion cleanup control flow"
    );

    write(file, content);
}

function patchPrivacyDeletionTests() {
    const file = "verification-tests/privacyDeletion.test.js";
    let content = read(file);
    const marker = `test("completion persistence failure prevents a successful deletion result", async () => {`;
    const inserted = `test("endSession failure after successful deletion preserves the completed result", async () => {\n    const jobUpdates = [];\n    const endError = new Error("end session failed after completion");\n    const models = createModels({\n        PrivacyDeletionJob: createModel({\n            updateOne: async (filter, update) => {\n                jobUpdates.push({ filter, update });\n                return writeResult(1);\n            }\n        })\n    });\n\n    const result = await runMemberPrivacyDeletion({\n        guildId: "guild-a",\n        userId: "111111111111111111",\n        requestedBy: "owner",\n        models,\n        mongooseInstance: fakeMongoose({ endError })\n    });\n\n    assert.equal(result.success, true);\n    assert.equal(result.status, "completed");\n    assert.equal(result.pending, false);\n    assert.equal(result.manifest.metadata.sessionCleanupWarning, endError.message);\n    assert.ok(jobUpdates.some(entry => entry.update.$set?.status === "completed"));\n    assert.equal(jobUpdates.some(entry => entry.update.$set?.status === "failed"), false);\n    assert.ok(jobUpdates.some(entry =>\n        entry.update.$set?.["manifest.metadata.sessionCleanupWarning"] === endError.message\n    ));\n});\n\n`;
    content = replaceOnce(content, marker, `${inserted}${marker}`, "privacy deletion cleanup regression test");
    write(file, content);
}

function patchEnvironmentWorkflow() {
    const file = ".github/workflows/isolated-environment-gate.yml";
    let content = read(file);

    const checkout = `      - name: Checkout exact ref\n        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2`;
    const initialize = `      - name: Initialize redacted environment record\n        shell: bash\n        run: |\n          set -euo pipefail\n          node <<'NODE'\n          const fs = require("node:fs");\n          const path = require("node:path");\n          const rawSha = String(process.env.TEST_COMMIT_SHA || process.env.GITHUB_SHA || "").trim().toLowerCase();\n          const safeSha = /^[a-f0-9]{40}$/.test(rawSha) ? rawSha : "local";\n          const directory = path.resolve(process.env.GATE_RECORD_DIR || "artifacts");\n          fs.mkdirSync(directory, { recursive: true });\n          const record = {\n            schemaVersion: 1,\n            status: "failed",\n            startedAt: new Date().toISOString(),\n            finishedAt: null,\n            commitSha: rawSha || "local",\n            errorCode: "GATE_NOT_COMPLETED",\n            evidence: {}\n          };\n          fs.writeFileSync(\n            path.join(directory, \`environment-gate-\${safeSha}.json\`),\n            JSON.stringify(record, null, 2) + "\\n",\n            { mode: 0o600 }\n          );\n          NODE\n\n${checkout}`;
    content = replaceOnce(content, checkout, initialize, "initialize environment record before checkout");

    const preflight = `\n      - name: Refuse stale or production-targeted execution\n        shell: bash\n        run: |\n          set -euo pipefail\n          test "$TEST_ENVIRONMENT_CONFIRMATION" = "ISOLATED_TEST_ONLY"\n          test "$TEST_COMMIT_SHA" = "$(git rev-parse HEAD)"\n          test -n "$TEST_MONGO_URI"\n          test -n "$TEST_DISCORD_TOKEN"\n          test -n "$TEST_PUBLIC_BASE_URL"\n          test -n "$TEST_ALLOWED_HOSTS"\n          test -n "$PRODUCTION_PUBLIC_BASE_URL"\n          test -n "$PRODUCTION_DISCORD_CLIENT_IDS"\n          test -n "$PRODUCTION_GUILD_IDS"\n          test -n "$PRODUCTION_CHANNEL_IDS"\n`;
    content = replaceOnce(content, preflight, "\n", "remove shell preflight that bypassed record persistence");
    write(file, content);
}

function patchEnvironmentGateScript() {
    const file = "scripts/runIsolatedEnvironmentGate.js";
    let content = read(file);

    content = replaceOnce(
        content,
        "        allowedHosts: [...allowedHosts].sort(),",
        "        allowedHosts: [...allowedHosts].sort((a, b) => a.localeCompare(b)),",
        "deterministic allowed host sorting"
    );

    const hashFunction = `function hashIdentifier(value) {\n    return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);\n}\n`;
    const helpers = `${hashFunction}\nfunction normalizeRecordSha(value) {\n    const normalized = String(value || "").trim().toLowerCase();\n    return /^[a-f0-9]{40}$/.test(normalized) ? normalized : "local";\n}\n\nfunction resolveRecordDirectory(recordDir, repositoryRoot = path.resolve(__dirname, "..")) {\n    const root = path.resolve(repositoryRoot);\n    const directory = path.resolve(root, String(recordDir || "artifacts"));\n    const relative = path.relative(root, directory);\n    if (relative.startsWith("..") || path.isAbsolute(relative)) {\n        const error = new Error("ENV_GATE_RECORD_DIRECTORY_OUTSIDE_REPOSITORY");\n        error.code = "ENV_GATE_RECORD_DIRECTORY_OUTSIDE_REPOSITORY";\n        throw error;\n    }\n    return directory;\n}\n\nfunction currentCheckoutSha(options = {}) {\n    if (typeof options.currentCheckoutSha === "function") {\n        return String(options.currentCheckoutSha() || "").trim().toLowerCase();\n    }\n    const gitBinary = process.platform === "win32" ? "git.exe" : "/usr/bin/git";\n    const result = spawnSync(gitBinary, ["rev-parse", "HEAD"], {\n        cwd: path.resolve(__dirname, ".."),\n        encoding: "utf8",\n        timeout: 10000\n    });\n    if (result.error || result.status !== 0) {\n        const error = new Error("CURRENT_COMMIT_SHA_UNAVAILABLE");\n        error.code = "CURRENT_COMMIT_SHA_UNAVAILABLE";\n        throw error;\n    }\n    return String(result.stdout || "").trim().toLowerCase();\n}\n\nfunction assertCurrentCheckoutSha(expectedSha, options = {}) {\n    const actualSha = currentCheckoutSha(options);\n    if (!/^[a-f0-9]{40}$/.test(actualSha)) {\n        const error = new Error("INVALID_CURRENT_COMMIT_SHA");\n        error.code = "INVALID_CURRENT_COMMIT_SHA";\n        throw error;\n    }\n    if (actualSha !== String(expectedSha || "").trim().toLowerCase()) {\n        const error = new Error("TEST_COMMIT_SHA_MISMATCH");\n        error.code = "TEST_COMMIT_SHA_MISMATCH";\n        throw error;\n    }\n    return actualSha;\n}\n\nfunction gateErrorDetails(error) {\n    const message = String(error?.message || error || "ENVIRONMENT_GATE_FAILED");\n    const separator = message.indexOf(":");\n    const messageCode = separator === -1 ? message : message.slice(0, separator);\n    const detail = separator === -1 ? "" : message.slice(separator + 1);\n    const errorCode = String(error?.code || messageCode || "ENVIRONMENT_GATE_FAILED");\n    const missing = errorCode === "MISSING_TEST_ENVIRONMENT"\n        ? detail.split(",").map(item => item.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b))\n        : [];\n    return { errorCode, missing };\n}\n`;
    content = replaceOnce(content, hashFunction, helpers, "environment gate helpers");

    content = replaceOnce(
        content,
        `function writeRecord(config, record) {\n    const directory = path.resolve(config.recordDir);\n    fs.mkdirSync(directory, { recursive: true });\n    const safeSha = String(config.commitSha || "local").replace(/[^a-fA-F0-9_-]/g, "").slice(0, 64) || "local";\n    const filename = path.join(directory, \`environment-gate-\${safeSha}.json\`);`,
        `function writeRecord(config, record) {\n    const directory = resolveRecordDirectory(config.recordDir);\n    fs.mkdirSync(directory, { recursive: true });\n    const safeSha = normalizeRecordSha(config.commitSha);\n    const filename = path.join(directory, \`environment-gate-\${safeSha}.json\`);`,
        "bounded environment record path"
    );

    const oldMain = `async function main() {\n    let config = null;\n    let primaryError = null;\n    const startedAt = new Date().toISOString();\n    const record = {\n        schemaVersion: 1,\n        status: "failed",\n        startedAt,\n        finishedAt: null,\n        commitSha: String(process.env.TEST_COMMIT_SHA || process.env.GITHUB_SHA || "local"),\n        evidence: {}\n    };\n\n    try {\n        config = validateIsolatedEnvironment(process.env);\n        record.commitSha = config.commitSha;\n        record.environment = {\n            database: config.databaseName,\n            deploymentOriginHash: hashIdentifier(new URL(config.publicBaseUrl).origin),\n            productionOriginHash: hashIdentifier(config.productionOrigin),\n            productionResourceCounts: config.productionResourceCounts,\n            guildHash: hashIdentifier(config.guildId)\n        };\n        record.evidence.mongo = await runMongoGate(config);\n        record.evidence.oauth = await requestClientCredentials(config);\n        record.evidence.discord = await runDiscordBotGate(config);\n        record.evidence.deployment = runDeploymentSmoke(config);\n        record.evidence.selfBotLiveAutomation = {\n            executed: false,\n            reason: "Discord standard-user automation is not part of the compliant live gate"\n        };\n        record.status = "passed";\n        return record;\n    } catch (error) {\n        record.error = redactSecrets(error?.message || error, config);\n        primaryError = Object.assign(error instanceof Error ? error : new Error(String(error)), {\n            gateRecord: record,\n            gateConfig: config\n        });\n        throw primaryError;\n    } finally {\n        record.finishedAt = new Date().toISOString();\n        const fallbackConfig = config || {\n            commitSha: record.commitSha,\n            recordDir: String(process.env.GATE_RECORD_DIR || "artifacts")\n        };\n        const persistence = persistGateRecord(fallbackConfig, record);\n        if (!persistence.ok && !primaryError) throw persistence.error;\n    }\n}\n`;

    const newMain = `async function runIsolatedEnvironmentGate(env = process.env, options = {}) {\n    let config = null;\n    let primaryError = null;\n    const record = {\n        schemaVersion: 1,\n        status: "failed",\n        startedAt: new Date().toISOString(),\n        finishedAt: null,\n        commitSha: String(env.TEST_COMMIT_SHA || env.GITHUB_SHA || "local"),\n        evidence: {}\n    };\n\n    try {\n        config = validateIsolatedEnvironment(env);\n        assertCurrentCheckoutSha(config.commitSha, options);\n        record.commitSha = config.commitSha;\n        record.environment = {\n            database: config.databaseName,\n            deploymentOriginHash: hashIdentifier(new URL(config.publicBaseUrl).origin),\n            productionOriginHash: hashIdentifier(config.productionOrigin),\n            productionResourceCounts: config.productionResourceCounts,\n            guildHash: hashIdentifier(config.guildId)\n        };\n        record.evidence.mongo = await (options.runMongoGate || runMongoGate)(config);\n        record.evidence.oauth = await (options.requestClientCredentials || requestClientCredentials)(config);\n        record.evidence.discord = await (options.runDiscordBotGate || runDiscordBotGate)(config);\n        record.evidence.deployment = await (options.runDeploymentSmoke || runDeploymentSmoke)(config);\n        record.evidence.selfBotLiveAutomation = {\n            executed: false,\n            reason: "Discord standard-user automation is not part of the compliant live gate"\n        };\n        record.status = "passed";\n    } catch (error) {\n        const details = gateErrorDetails(error);\n        record.error = redactSecrets(error?.message || error, config);\n        record.errorCode = details.errorCode;\n        if (details.missing.length) record.missing = details.missing;\n        primaryError = Object.assign(error instanceof Error ? error : new Error(String(error)), {\n            gateRecord: record,\n            gateConfig: config\n        });\n    }\n\n    record.finishedAt = new Date().toISOString();\n    const fallbackConfig = config || {\n        commitSha: record.commitSha,\n        recordDir: String(env.GATE_RECORD_DIR || "artifacts")\n    };\n    const persistence = persistGateRecord(fallbackConfig, record, {\n        writer: options.writer,\n        logger: options.logger\n    });\n    if (!persistence.ok) {\n        if (primaryError) {\n            primaryError.recordPersistenceError = persistence.error.message;\n        } else {\n            primaryError = Object.assign(persistence.error, {\n                gateRecord: record,\n                gateConfig: config\n            });\n        }\n    }\n    if (primaryError) throw primaryError;\n    return record;\n}\n\nasync function main() {\n    return runIsolatedEnvironmentGate(process.env);\n}\n`;
    content = replaceOnce(content, oldMain, newMain, "environment gate main control flow");

    content = replaceOnce(
        content,
        `module.exports = {\n    REQUIRED_NAMES,\n    databaseNameFromMongoUri,\n    exactAllowedHosts,\n    exactSnowflakeSet,\n    hashIdentifier,\n    normalizeHttpsOrigin,\n    persistGateRecord,\n    redactSecrets,\n    validateIsolatedEnvironment,\n    writeRecord\n};`,
        `module.exports = {\n    REQUIRED_NAMES,\n    assertCurrentCheckoutSha,\n    databaseNameFromMongoUri,\n    exactAllowedHosts,\n    exactSnowflakeSet,\n    gateErrorDetails,\n    hashIdentifier,\n    normalizeHttpsOrigin,\n    normalizeRecordSha,\n    persistGateRecord,\n    redactSecrets,\n    resolveRecordDirectory,\n    runIsolatedEnvironmentGate,\n    validateIsolatedEnvironment,\n    writeRecord\n};`,
        "environment gate exports"
    );

    write(file, content);
}

function patchEnvironmentGateTests() {
    const file = "discord/tests/isolatedEnvironmentGate.test.js";
    let content = read(file);

    content = replaceOnce(
        content,
        `    hashIdentifier,\n    persistGateRecord,\n    redactSecrets,\n    validateIsolatedEnvironment`,
        `    assertCurrentCheckoutSha,\n    hashIdentifier,\n    persistGateRecord,\n    redactSecrets,\n    runIsolatedEnvironmentGate,\n    validateIsolatedEnvironment`,
        "environment gate test imports"
    );

    const marker = `test("Mongo database name parser handles standard and SRV connection strings", () => {`;
    const inserted = `test("missing environment still persists a redacted failure record", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.\n    const records = [];\n    const env = {\n        TEST_ENVIRONMENT_CONFIRMATION: "ISOLATED_TEST_ONLY",\n        TEST_COMMIT_SHA: "abcdef1234567890abcdef1234567890abcdef12"\n    };\n\n    await assert.rejects(\n        runIsolatedEnvironmentGate(env, {\n            writer(_config, record) {\n                records.push(structuredClone(record));\n                return "memory://environment-gate.json";\n            },\n            logger: { log() {}, error() {} }\n        }),\n        /MISSING_TEST_ENVIRONMENT/\n    );\n\n    assert.equal(records.length, 1);\n    assert.equal(records[0].status, "failed");\n    assert.equal(records[0].errorCode, "MISSING_TEST_ENVIRONMENT");\n    assert.ok(records[0].missing.includes("TEST_MONGO_URI"));\n    assert.equal(JSON.stringify(records[0]).includes("test-bot-token-value-not-a-real-token"), false);\n});\n\ntest("SHA mismatch persists evidence before external checks run", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.\n    const records = [];\n    let externalCalls = 0;\n    await assert.rejects(\n        runIsolatedEnvironmentGate(validEnvironment(), {\n            currentCheckoutSha: () => "1111111111111111111111111111111111111111",\n            runMongoGate: async () => { externalCalls++; },\n            writer(_config, record) {\n                records.push(structuredClone(record));\n                return "memory://environment-gate.json";\n            },\n            logger: { log() {}, error() {} }\n        }),\n        error => error?.code === "TEST_COMMIT_SHA_MISMATCH"\n    );\n\n    assert.equal(externalCalls, 0);\n    assert.equal(records.length, 1);\n    assert.equal(records[0].errorCode, "TEST_COMMIT_SHA_MISMATCH");\n});\n\ntest("record writer failure does not replace the primary gate error", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.\n    await assert.rejects(\n        runIsolatedEnvironmentGate(validEnvironment(), {\n            currentCheckoutSha: () => "1111111111111111111111111111111111111111",\n            writer() { throw new Error("writer failed"); },\n            logger: { log() {}, error() {} }\n        }),\n        error => {\n            assert.equal(error.code, "TEST_COMMIT_SHA_MISMATCH");\n            assert.match(error.recordPersistenceError, /writer failed/);\n            return true;\n        }\n    );\n});\n\ntest("record writer failure becomes primary only after a successful gate", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.\n    const success = async () => ({ ok: true });\n    await assert.rejects(\n        runIsolatedEnvironmentGate(validEnvironment(), {\n            currentCheckoutSha: () => validEnvironment().TEST_COMMIT_SHA,\n            runMongoGate: success,\n            requestClientCredentials: success,\n            runDiscordBotGate: success,\n            runDeploymentSmoke: success,\n            writer() { throw new Error("writer failed"); },\n            logger: { log() {}, error() {} }\n        }),\n        error => error?.code === "ENV_GATE_RECORD_WRITE_FAILED"\n    );\n});\n\ntest("checkout SHA validation accepts only the exact expected commit", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.\n    const expected = validEnvironment().TEST_COMMIT_SHA;\n    assert.equal(assertCurrentCheckoutSha(expected, { currentCheckoutSha: () => expected }), expected);\n    assert.throws(\n        () => assertCurrentCheckoutSha(expected, { currentCheckoutSha: () => "invalid" }),\n        /INVALID_CURRENT_COMMIT_SHA/\n    );\n});\n\n`;
    content = replaceOnce(content, marker, `${inserted}${marker}`, "environment gate regression tests");

    content = replaceOnce(
        content,
        `    assert.match(workflow, /workflow_dispatch/);`,
        `    assert.match(workflow, /workflow_dispatch/);\n    assert.match(workflow, /Initialize redacted environment record/);\n    assert.doesNotMatch(workflow, /test -n \"\\$TEST_MONGO_URI\"/);`,
        "environment workflow regression assertions"
    );

    write(file, content);
}

patchPrivacyDeletion();
patchPrivacyDeletionTests();
patchEnvironmentWorkflow();
patchEnvironmentGateScript();
patchEnvironmentGateTests();
console.log("Applied final quality gate remediation patches.");
