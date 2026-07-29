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
    const index = content.indexOf(before);
    if (index === -1) throw new Error(`Patch target not found: ${label}`);
    if (content.indexOf(before, index + before.length) !== -1) {
        throw new Error(`Patch target is ambiguous: ${label}`);
    }
    return `${content.slice(0, index)}${after}${content.slice(index + before.length)}`;
}

function patchVoiceLifecycle() {
    const file = "discord/voiceWorker/lifecycle.js";
    let content = read(file);
    content = replaceOnce(
        content,
        `    const markFailed = deps.markSessionFailed || ((...args) => sessionManager.markSessionFailed?.(...args));\n`,
        "",
        "remove unused voice markFailed dependency"
    );
    write(file, content);
}

function patchGuildRoute() {
    const file = "discord/verification/routes/guild.js";
    let content = read(file);
    content = replaceOnce(
        content,
        `  const dashboardUrl = getPublicBaseUrl(req);`,
        `  const dashboardUrl = getPublicBaseUrl();`,
        "remove unused getPublicBaseUrl argument"
    );
    write(file, content);
}

function patchEvents() {
    const file = "discord/index/events.js";
    let content = read(file);

    const oldExecute = `async function executeProtectionAction({ member, result, message, deleteMode = "none" }) {\n    const action = result?.action || "log";\n    const output = {\n        action,\n        attempted: action !== "log",\n        success: false,\n        reason: result?.reason || null,\n        error: null,\n        timeoutMs: result?.minutes ? result.minutes * 60000 : null,\n        deletedMessages: 0\n    };\n\n    try {\n        if (message && deleteMode === "raid") {\n            output.deletedMessages = await deleteRaidEvidenceSafely(message, 5);\n        } else if (message && deleteMode === "single") {\n            output.deletedMessages = await deleteMessageWithLog(message, "protection-pipeline") ? 1 : 0;\n        }\n\n        if (action === "timeout") {\n            if (!member.manageable) throw new Error("member is not manageable");\n            await member.timeout((result.minutes || 10) * 60000, result.reason);\n            output.success = true;\n        } else if (action === "ban") {\n            if (!canBanMember(member)) throw new Error("missing BanMembers or member is not bannable");\n            await member.ban({ reason: result.reason });\n            output.success = true;\n        } else if (action === "kick") {\n            if (!member.kickable) throw new Error("member is not kickable");\n            await member.kick(result.reason);\n            output.success = true;\n        } else {\n            output.attempted = false;\n            output.success = true;\n        }\n    } catch (err) {\n        output.error = err.message;\n        console.warn(\`[PROTECTION] Action \${action} failed for \${member?.id}: \${err.message}\`);\n    }\n\n    return output;\n}`;

    const newExecute = `async function deleteProtectionEvidence(message, deleteMode) {\n    if (!message) return 0;\n    if (deleteMode === "raid") return deleteRaidEvidenceSafely(message, 5);\n    if (deleteMode === "single") {\n        return await deleteMessageWithLog(message, "protection-pipeline") ? 1 : 0;\n    }\n    return 0;\n}\n\nasync function applyProtectionMemberAction(member, result, action) {\n    if (action === "timeout") {\n        if (!member.manageable) throw new Error("member is not manageable");\n        await member.timeout((result.minutes || 10) * 60000, result.reason);\n        return { attempted: true, success: true };\n    }\n    if (action === "ban") {\n        if (!canBanMember(member)) throw new Error("missing BanMembers or member is not bannable");\n        await member.ban({ reason: result.reason });\n        return { attempted: true, success: true };\n    }\n    if (action === "kick") {\n        if (!member.kickable) throw new Error("member is not kickable");\n        await member.kick(result.reason);\n        return { attempted: true, success: true };\n    }\n    return { attempted: false, success: true };\n}\n\nasync function executeProtectionAction({ member, result, message, deleteMode = "none" }) {\n    const action = result?.action || "log";\n    const output = {\n        action,\n        attempted: action !== "log",\n        success: false,\n        reason: result?.reason || null,\n        error: null,\n        timeoutMs: result?.minutes ? result.minutes * 60000 : null,\n        deletedMessages: 0\n    };\n\n    try {\n        output.deletedMessages = await deleteProtectionEvidence(message, deleteMode);\n        Object.assign(output, await applyProtectionMemberAction(member, result, action));\n    } catch (err) {\n        output.error = err.message;\n        console.warn(\`[PROTECTION] Action \${action} failed for \${member?.id}: \${err.message}\`);\n    }\n\n    return output;\n}`;
    content = replaceOnce(content, oldExecute, newExecute, "protection action helpers");

    const mergeMarker = `function mergeProtectionFindings(findings = []) {`;
    const mergeHelpers = `function mergeProtectionMetadata(findings) {\n    const metadata = {};\n    for (const item of findings) {\n        if (item.metadata && typeof item.metadata === "object") Object.assign(metadata, item.metadata);\n    }\n    return metadata;\n}\n\nfunction resolveProtectionDeleteMode(findings) {\n    if (findings.some(item => item.trigger?.includes("Anti-Raid"))) return "raid";\n    if (findings.some(item => item.shouldDelete)) return "single";\n    return "none";\n}\n\n`;
    content = replaceOnce(content, mergeMarker, `${mergeHelpers}${mergeMarker}`, "protection merge helpers");
    content = replaceOnce(
        content,
        `        metadata: {\n            ...findings.reduce((out, item) => ({ ...out, ...(item.metadata || {}) }), {}),\n            ruleIds\n        },\n        deleteMode: findings.some(item => item.trigger?.includes("Anti-Raid"))\n            ? "raid"\n            : findings.some(item => item.shouldDelete)\n                ? "single"\n                : "none"`,
        `        metadata: {\n            ...mergeProtectionMetadata(findings),\n            ruleIds\n        },\n        deleteMode: resolveProtectionDeleteMode(findings)`,
        "protection merge smells"
    );
    write(file, content);
}

function patchOAuthLifecycle() {
    const file = "discord/verification/utils/oauthTokenLifecycle.js";
    let content = read(file);
    const marker = `async function refreshTokenField({ model, tokenField, redirectUri, now, config, discordApi, prepareTokenStorage }) {`;
    const helpers = `function applyRefreshOutcome(summary, outcome) {\n    if (outcome?.refreshed) {\n        summary.refreshed++;\n        return;\n    }\n    if (outcome?.skipped) {\n        summary.skipped++;\n        if (String(outcome.reason || "").includes("changed")) summary.conflicts++;\n        return;\n    }\n    if (!outcome?.failed) return;\n    summary.failed++;\n    if (outcome.revoked) summary.revoked++;\n    if (outcome.persisted === false) summary.persistenceFailed++;\n    if (summary.errors.length < 10) summary.errors.push(outcome);\n}\n\nfunction recordRefreshException(summary, tokenField, doc, error) {\n    summary.failed++;\n    summary.persistenceFailed++;\n    if (summary.errors.length >= 10) return;\n    summary.errors.push({\n        ok: false,\n        tokenField,\n        userId: doc.discord?.userId || doc.id,\n        error: safeError(error),\n        persisted: false\n    });\n}\n\n`;
    content = replaceOnce(content, marker, `${helpers}${marker}`, "OAuth refresh summary helpers");

    const oldLoop = `    for (const doc of docs) {\n        try {\n            const outcome = await refreshOneOAuthUser(doc, {\n                model,\n                discordApi,\n                redirectUri,\n                now,\n                marginMs: config.marginMs,\n                failMax: config.failMax,\n                prepareTokenStorage,\n                tokenField\n            });\n            if (outcome?.refreshed) {\n                summary.refreshed++;\n                continue;\n            }\n            if (outcome?.skipped) {\n                summary.skipped++;\n                if (String(outcome.reason || '').includes('changed')) summary.conflicts++;\n                continue;\n            }\n            if (outcome?.failed) {\n                summary.failed++;\n                if (outcome.revoked) summary.revoked++;\n                if (outcome.persisted === false) summary.persistenceFailed++;\n                if (summary.errors.length < 10) summary.errors.push(outcome);\n            }\n        } catch (err) {\n            summary.failed++;\n            summary.persistenceFailed++;\n            if (summary.errors.length < 10) {\n                summary.errors.push({\n                    ok: false,\n                    tokenField,\n                    userId: doc.discord?.userId || doc.id,\n                    error: safeError(err),\n                    persisted: false\n                });\n            }\n        }\n    }`;
    const newLoop = `    for (const doc of docs) {\n        try {\n            const outcome = await refreshOneOAuthUser(doc, {\n                model,\n                discordApi,\n                redirectUri,\n                now,\n                marginMs: config.marginMs,\n                failMax: config.failMax,\n                prepareTokenStorage,\n                tokenField\n            });\n            applyRefreshOutcome(summary, outcome);\n        } catch (error) {\n            recordRefreshException(summary, tokenField, doc, error);\n        }\n    }`;
    content = replaceOnce(content, oldLoop, newLoop, "OAuth refresh loop complexity");
    write(file, content);
}

function patchSecretScanner() {
    const file = "scripts/checkSecretLeaks.js";
    let content = read(file);
    content = replaceOnce(
        content,
        `        regex: /(?<![A-Za-z0-9_])[A-Za-z\\d]{20,30}\\.[A-Za-z\\d_-]{6}\\.[A-Za-z\\d_-]{25,50}(?![A-Za-z0-9_])/g`,
        `        regex: /(?<![\\w-])[\\w-]{20,30}\\.[\\w-]{6}\\.[\\w-]{25,50}(?![\\w-])/g`,
        "Discord token character classes"
    );
    content = replaceOnce(
        content,
        `        regex: /(?:github_pat_[A-Za-z0-9_]{20,255}|gh[pousr]_[A-Za-z0-9]{30,255})/g`,
        `        regex: /(?:github_pat_\\w{20,255}|gh[pousr]_[A-Za-z0-9]{30,255})/g`,
        "GitHub token character class"
    );
    content = replaceOnce(
        content,
        `const ASSIGNMENT_PATTERN = /\\b(token|secret|password|pin|api[_-]?key|webhook(?:url)?)\\b\\s*[:=]\\s*["']([^"'\\r\\n]{12,512})["']/gi;`,
        `const ASSIGNMENT_NAME_PATTERN = /\\b(?:token|secret|password|pin|api[_-]?key|webhook(?:url)?)\\b/gi;\nconst MAX_ASSIGNMENT_LINE_LENGTH = 4096;\nconst MAX_SCANNED_FILE_BYTES = 2 * 1024 * 1024;\nconst REPOSITORY_ROOT = path.resolve(__dirname, "..");\nconst GIT_BINARY = process.platform === "win32" ? "git.exe" : "/usr/bin/git";`,
        "bounded assignment scanner constants"
    );

    const pathMarker = `function shouldScanPath(filePath) {`;
    const pathHelpers = `function resolveTrackedPath(root, relativePath) {\n    const repositoryRoot = path.resolve(root);\n    const resolved = path.resolve(repositoryRoot, String(relativePath || ""));\n    const relative = path.relative(repositoryRoot, resolved);\n    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {\n        throw new Error("tracked path escaped repository root");\n    }\n    return resolved;\n}\n\nfunction assignmentFindings(source, filePath) {\n    const findings = [];\n    let offset = 0;\n    for (const line of source.split(/\\r?\\n/)) {\n        if (line.length <= MAX_ASSIGNMENT_LINE_LENGTH) {\n            ASSIGNMENT_NAME_PATTERN.lastIndex = 0;\n            for (const match of line.matchAll(ASSIGNMENT_NAME_PATTERN)) {\n                const tail = line.slice(match.index + match[0].length);\n                const assignment = /^\\s*[:=]\\s*(["'])/.exec(tail);\n                if (!assignment) continue;\n                const quote = assignment[1];\n                const valueStart = match.index + match[0].length + assignment[0].length;\n                const valueEnd = line.indexOf(quote, valueStart);\n                if (valueEnd === -1) continue;\n                const value = line.slice(valueStart, valueEnd);\n                if (value.length < 12 || value.length > 512 || PLACEHOLDER_PATTERN.test(value)) continue;\n                findings.push({\n                    code: "HARDCODED_SECRET_ASSIGNMENT",\n                    filePath,\n                    line: lineNumber(source, offset + match.index)\n                });\n            }\n        }\n        offset += line.length + 1;\n    }\n    return findings;\n}\n\n`;
    content = replaceOnce(content, pathMarker, `${pathHelpers}${pathMarker}`, "secret scanner path and assignment helpers");

    const oldAnalyze = `function analyzeText(text, filePath = "fixture") {\n    const source = String(text || "");\n    const findings = [];\n\n    for (const { code, regex } of PATTERNS) {\n        regex.lastIndex = 0;\n        for (const match of source.matchAll(regex)) {\n            findings.push({ code, filePath, line: lineNumber(source, match.index) });\n        }\n    }\n\n    ASSIGNMENT_PATTERN.lastIndex = 0;\n    for (const match of source.matchAll(ASSIGNMENT_PATTERN)) {\n        const value = String(match[2] || "");\n        if (PLACEHOLDER_PATTERN.test(value)) continue;\n        findings.push({\n            code: "HARDCODED_SECRET_ASSIGNMENT",\n            filePath,\n            line: lineNumber(source, match.index)\n        });\n    }\n\n    return findings;\n}`;
    const newAnalyze = `function analyzeText(text, filePath = "fixture") {\n    const source = String(text || "");\n    const findings = [];\n\n    for (const { code, regex } of PATTERNS) {\n        regex.lastIndex = 0;\n        for (const match of source.matchAll(regex)) {\n            findings.push({ code, filePath, line: lineNumber(source, match.index) });\n        }\n    }\n\n    findings.push(...assignmentFindings(source, filePath));\n    return findings;\n}`;
    content = replaceOnce(content, oldAnalyze, newAnalyze, "bounded assignment analysis");

    const oldRepository = `function trackedFiles() {\n    const result = spawnSync("git", ["ls-files", "-z"], {\n        encoding: "utf8",\n        maxBuffer: 16 * 1024 * 1024\n    });\n    if (result.status !== 0) {\n        throw new Error("unable to enumerate tracked files for secret scanning");\n    }\n    return result.stdout.split("\\0").filter(Boolean);\n}\n\nfunction scanRepository(root = process.cwd()) {\n    const findings = [];\n    for (const relativePath of trackedFiles()) {\n        if (!shouldScanPath(relativePath)) continue;\n        const absolutePath = path.join(root, relativePath);\n        let buffer;\n        try {\n            buffer = fs.readFileSync(absolutePath);\n        } catch {\n            continue;\n        }\n        if (buffer.length > 2 * 1024 * 1024 || buffer.includes(0)) continue;\n        findings.push(...analyzeText(buffer.toString("utf8"), relativePath));\n    }\n    return findings;\n}`;
    const newRepository = `function trackedFiles(root = REPOSITORY_ROOT) {\n    const result = spawnSync(GIT_BINARY, ["ls-files", "-z"], {\n        cwd: path.resolve(root),\n        encoding: "utf8",\n        maxBuffer: 16 * 1024 * 1024\n    });\n    if (result.status !== 0) {\n        throw new Error("unable to enumerate tracked files for secret scanning");\n    }\n    return result.stdout.split("\\0").filter(Boolean);\n}\n\nfunction scanRepository(root = REPOSITORY_ROOT) {\n    const repositoryRoot = path.resolve(root);\n    const findings = [];\n    for (const relativePath of trackedFiles(repositoryRoot)) {\n        if (!shouldScanPath(relativePath)) continue;\n        let absolutePath;\n        try {\n            absolutePath = resolveTrackedPath(repositoryRoot, relativePath);\n        } catch {\n            continue;\n        }\n        let buffer;\n        try {\n            buffer = fs.readFileSync(absolutePath);\n        } catch {\n            continue;\n        }\n        if (buffer.length > MAX_SCANNED_FILE_BYTES || buffer.includes(0)) continue;\n        findings.push(...analyzeText(buffer.toString("utf8"), relativePath));\n    }\n    return findings;\n}`;
    content = replaceOnce(content, oldRepository, newRepository, "secret scanner repository boundary");
    content = replaceOnce(
        content,
        `module.exports = {\n    analyzeText,\n    scanRepository,\n    shouldScanPath\n};`,
        `module.exports = {\n    analyzeText,\n    resolveTrackedPath,\n    scanRepository,\n    shouldScanPath\n};`,
        "secret scanner exports"
    );
    write(file, content);
}

function patchSecretTests() {
    const file = "discord/tests/secretLeakGuard.test.js";
    let content = read(file);
    content = replaceOnce(
        content,
        `const { analyzeText, shouldScanPath } = require("../../scripts/checkSecretLeaks");`,
        `const { analyzeText, resolveTrackedPath, shouldScanPath } = require("../../scripts/checkSecretLeaks");`,
        "secret scanner test imports"
    );
    const marker = `test("secret guard handles long adversarial non-matches in bounded time",`;
    const testBlock = `test("secret guard rejects tracked paths outside the repository root", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.\n    assert.throws(() => resolveTrackedPath("/tmp/repository", "../outside.txt"), /escaped repository root/);\n    assert.equal(resolveTrackedPath("/tmp/repository", "discord/index.js"), "/tmp/repository/discord/index.js");\n});\n\n`;
    content = replaceOnce(content, marker, `${testBlock}${marker}`, "secret scanner path boundary test");
    write(file, content);
}

function patchDiscordCompatibility() {
    const file = "scripts/checkDiscordV14Compatibility.js";
    let content = read(file);
    const analyzeMarker = `function analyzeSource(source, filename = "source.js") {`;
    const helpers = `function inspectCallExpression(node, findings) {\n    if (node.type !== "CallExpression") return;\n    const method = propertyName(node.callee);\n    if (method === "has") {\n        const permission = literalString(node.arguments?.[0]);\n        if (permission && LEGACY_PERMISSION_KEYS.has(permission)) {\n            findings.push(finding(\n                "LEGACY_PERMISSION_HAS",\n                \`Use PermissionFlagsBits instead of .has("\${permission}")\`,\n                node\n            ));\n        }\n    }\n    if (method === "isText") {\n        findings.push(finding("DEPRECATED_IS_TEXT", "Use isTextBased()/isSendable() instead of isText()", node));\n    }\n    if (method === "all" && node.callee.object?.type === "Identifier" && node.callee.object.name === "app") {\n        findings.push(finding("STATE_ROUTE_APP_ALL", "Use explicit HTTP methods instead of app.all()", node));\n    }\n    const route = httpRoutePath(node);\n    const revealRoute = route?.path?.startsWith("/api/reveal-") || route?.path?.startsWith("/api/reveal/");\n    if (route?.method === "get" && route.path && (FORBIDDEN_STATE_GET_ROUTES.has(route.path) || revealRoute)) {\n        findings.push(finding(\n            "STATE_CHANGING_GET",\n            \`Sensitive or state-changing route \${route.path} must use POST with CSRF\`,\n            node\n        ));\n    }\n    if (method === "deleteMany" && isEmptyObject(node.arguments?.[0])) {\n        findings.push(finding(\n            "UNSCOPED_DELETE_MANY",\n            "Unscoped deleteMany({}) is forbidden in production runtime",\n            node\n        ));\n    }\n    if (isDirectChannelCacheClear(node)) {\n        findings.push(finding("DIRECT_CHANNEL_CACHE_CLEAR", "Do not clear the Discord channel cache directly", node));\n    }\n}\n\nfunction inspectProperty(node, findings) {\n    if (node.type !== "Property") return;\n    const key = objectPropertyName(node);\n    if (key && LEGACY_PERMISSION_KEYS.has(key)) {\n        findings.push(finding(\n            "LEGACY_PERMISSION_OBJECT_KEY",\n            \`Use the canonical Discord.js v14 permission key instead of \${key}\`,\n            node\n        ));\n    }\n}\n\nfunction inspectCompatibilityNode(node, findings) {\n    inspectCallExpression(node, findings);\n    inspectProperty(node, findings);\n    if (isReqQueryPin(node)) {\n        findings.push(finding("QUERY_PIN", "Credentials must never be accepted from req.query.pin", node));\n    }\n}\n\n`;
    content = replaceOnce(content, analyzeMarker, `${helpers}${analyzeMarker}`, "Discord compatibility inspection helpers");

    const oldWalk = `    const findings = [];\n    walk(ast, node => {\n        if (node.type === "CallExpression") {\n            const method = propertyName(node.callee);\n            if (method === "has") {\n                const permission = literalString(node.arguments?.[0]);\n                if (permission && LEGACY_PERMISSION_KEYS.has(permission)) {\n                    findings.push(finding(\n                        "LEGACY_PERMISSION_HAS",\n                        \`Use PermissionFlagsBits instead of .has("\${permission}")\`,\n                        node\n                    ));\n                }\n            }\n            if (method === "isText") {\n                findings.push(finding("DEPRECATED_IS_TEXT", "Use isTextBased()/isSendable() instead of isText()", node));\n            }\n            if (method === "all" && node.callee.object?.type === "Identifier" && node.callee.object.name === "app") {\n                findings.push(finding("STATE_ROUTE_APP_ALL", "Use explicit HTTP methods instead of app.all()", node));\n            }\n            const route = httpRoutePath(node);\n            if (route?.method === "get" && route.path && (\n                FORBIDDEN_STATE_GET_ROUTES.has(route.path) ||\n                /^\\/api\\/reveal(?:-|\\/)/.test(route.path)\n            )) {\n                findings.push(finding(\n                    "STATE_CHANGING_GET",\n                    \`Sensitive or state-changing route \${route.path} must use POST with CSRF\`,\n                    node\n                ));\n            }\n            if (method === "deleteMany" && isEmptyObject(node.arguments?.[0])) {\n                findings.push(finding(\n                    "UNSCOPED_DELETE_MANY",\n                    "Unscoped deleteMany({}) is forbidden in production runtime",\n                    node\n                ));\n            }\n            if (isDirectChannelCacheClear(node)) {\n                findings.push(finding("DIRECT_CHANNEL_CACHE_CLEAR", "Do not clear the Discord channel cache directly", node));\n            }\n        }\n\n        if (node.type === "Property") {\n            const key = objectPropertyName(node);\n            if (key && LEGACY_PERMISSION_KEYS.has(key)) {\n                findings.push(finding(\n                    "LEGACY_PERMISSION_OBJECT_KEY",\n                    \`Use the canonical Discord.js v14 permission key instead of \${key}\`,\n                    node\n                ));\n            }\n        }\n\n        if (isReqQueryPin(node)) {\n            findings.push(finding("QUERY_PIN", "Credentials must never be accepted from req.query.pin", node));\n        }\n    });`;
    content = replaceOnce(
        content,
        oldWalk,
        `    const findings = [];\n    walk(ast, node => inspectCompatibilityNode(node, findings));`,
        "Discord compatibility analyzeSource complexity"
    );

    const oldList = `function listJavaScriptFiles(root) {\n    const output = [];\n    function visit(current) {\n        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {\n            const fullPath = path.join(current, entry.name);\n            const relative = fullPath.replaceAll("\\\\", "/");\n            if (entry.isDirectory()) {\n                if (entry.name === "tests" || entry.name === "node_modules" || entry.name === "coverage") continue;\n                visit(fullPath);\n            } else if (entry.isFile() && entry.name.endsWith(".js")) {\n                output.push(relative);\n            }\n        }\n    }\n    if (fs.existsSync(root)) visit(root);\n    return output.sort();\n}`;
    const newList = `const REPOSITORY_ROOT = path.resolve(__dirname, "..");\n\nfunction resolveSourceRoot(root) {\n    const resolved = path.resolve(REPOSITORY_ROOT, String(root || "discord"));\n    const relative = path.relative(REPOSITORY_ROOT, resolved);\n    if (relative.startsWith("..") || path.isAbsolute(relative)) {\n        throw new Error("Discord compatibility source root escaped repository");\n    }\n    return resolved;\n}\n\nfunction listJavaScriptFiles(root = "discord") {\n    const sourceRoot = resolveSourceRoot(root);\n    const output = [];\n    function visit(current) {\n        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {\n            const fullPath = path.join(current, entry.name);\n            if (entry.isDirectory()) {\n                if (entry.name === "tests" || entry.name === "node_modules" || entry.name === "coverage") continue;\n                visit(fullPath);\n            } else if (entry.isFile() && entry.name.endsWith(".js")) {\n                output.push(path.relative(REPOSITORY_ROOT, fullPath).replaceAll("\\\\", "/"));\n            }\n        }\n    }\n    if (fs.existsSync(sourceRoot)) visit(sourceRoot);\n    return output.sort((a, b) => a.localeCompare(b));\n}`;
    content = replaceOnce(content, oldList, newList, "Discord compatibility bounded file traversal");
    content = replaceOnce(
        content,
        `        const source = fs.readFileSync(file, "utf8");`,
        `        const source = fs.readFileSync(path.join(REPOSITORY_ROOT, file), "utf8");`,
        "Discord compatibility repository source read"
    );
    write(file, content);
}

function patchCoverageChecker() {
    const file = "scripts/checkCoverageThresholds.js";
    let content = read(file);
    const marker = `function formatPercent(value) {`;
    const helpers = `const REPOSITORY_ROOT = path.resolve(__dirname, "..");\nconst DEFAULT_REPORTS = Object.freeze([\n    "coverage/discord.lcov",\n    "coverage/voice.lcov",\n    "coverage/verification.lcov"\n]);\n\nfunction resolveCoverageReportPath(file, root = REPOSITORY_ROOT) {\n    const repositoryRoot = path.resolve(root);\n    const resolved = path.resolve(repositoryRoot, String(file || ""));\n    const relative = path.relative(repositoryRoot, resolved);\n    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.extname(resolved) !== ".lcov") {\n        throw new Error("coverage report path escaped repository or is not LCOV");\n    }\n    return resolved;\n}\n\n`;
    content = replaceOnce(content, marker, `${helpers}${marker}`, "coverage path helpers");

    const oldCli = `function runCli(args = process.argv.slice(2)) {\n    const files = args.length ? args : [\n        "coverage/discord.lcov",\n        "coverage/voice.lcov",\n        "coverage/verification.lcov"\n    ];\n    let failed = false;\n\n    for (const file of files) {\n        const normalized = path.normalize(file);\n        if (!fs.existsSync(normalized) || fs.statSync(normalized).size === 0) {\n            console.error(\`[COVERAGE] missing or empty report: \${file}\`);\n            failed = true;\n            continue;\n        }\n        const parsed = parseLcov(fs.readFileSync(normalized, "utf8"));\n        const result = evaluateCoverage(parsed);\n        const summary = Object.keys(result.metrics)\n            .map(name => \`\${name}=\${formatPercent(result.metrics[name])} (min \${formatPercent(result.thresholds[name])})\`)\n            .join(", ");\n        console.log(\`[COVERAGE] \${file}: \${summary}\`);\n        if (result.invalid.length) {\n            console.error(\`[COVERAGE] \${file} has missing coverage data: \${result.invalid.join(", ")}\`);\n            failed = true;\n        }\n        if (result.failures.length) {\n            console.error(\`[COVERAGE] \${file} below threshold: \${result.failures.join(", ")}\`);\n            failed = true;\n        }\n\n        const critical = evaluateCriticalFiles(parsed, CRITICAL_FILE_THRESHOLDS[path.basename(normalized)] || {});\n        for (const item of critical.results) {\n            if (item.missing) {\n                console.error(\`[COVERAGE] critical file missing from \${file}: \${item.sourcePath}\`);\n                continue;\n            }\n            const details = Object.keys(item.thresholds)\n                .map(name => \`\${name}=\${formatPercent(item.metrics[name])} (min \${formatPercent(item.thresholds[name])})\`)\n                .join(", ");\n            console.log(\`[COVERAGE] critical \${item.sourcePath}: \${details}\`);\n            if (item.failures.length) {\n                console.error(\`[COVERAGE] critical \${item.sourcePath} below threshold: \${item.failures.join(", ")}\`);\n            }\n        }\n        if (critical.failures.length) failed = true;\n    }\n\n    if (failed) process.exitCode = 1;\n}`;
    const newCli = `function reportCriticalCoverage(file, parsed, reportName) {\n    const critical = evaluateCriticalFiles(parsed, CRITICAL_FILE_THRESHOLDS[reportName] || {});\n    for (const item of critical.results) {\n        if (item.missing) {\n            console.error(\`[COVERAGE] critical file missing from \${file}: \${item.sourcePath}\`);\n            continue;\n        }\n        const details = Object.keys(item.thresholds)\n            .map(name => \`\${name}=\${formatPercent(item.metrics[name])} (min \${formatPercent(item.thresholds[name])})\`)\n            .join(", ");\n        console.log(\`[COVERAGE] critical \${item.sourcePath}: \${details}\`);\n        if (item.failures.length) {\n            console.error(\`[COVERAGE] critical \${item.sourcePath} below threshold: \${item.failures.join(", ")}\`);\n        }\n    }\n    return critical.failures.length > 0;\n}\n\nfunction evaluateCoverageReport(file) {\n    let absolutePath;\n    try {\n        absolutePath = resolveCoverageReportPath(file);\n    } catch (error) {\n        console.error(\`[COVERAGE] invalid report path \${file}: \${error.message}\`);\n        return true;\n    }\n    if (!fs.existsSync(absolutePath) || fs.statSync(absolutePath).size === 0) {\n        console.error(\`[COVERAGE] missing or empty report: \${file}\`);\n        return true;\n    }\n\n    const parsed = parseLcov(fs.readFileSync(absolutePath, "utf8"));\n    const result = evaluateCoverage(parsed);\n    const summary = Object.keys(result.metrics)\n        .map(name => \`\${name}=\${formatPercent(result.metrics[name])} (min \${formatPercent(result.thresholds[name])})\`)\n        .join(", ");\n    console.log(\`[COVERAGE] \${file}: \${summary}\`);\n    if (result.invalid.length) {\n        console.error(\`[COVERAGE] \${file} has missing coverage data: \${result.invalid.join(", ")}\`);\n    }\n    if (result.failures.length) {\n        console.error(\`[COVERAGE] \${file} below threshold: \${result.failures.join(", ")}\`);\n    }\n    const criticalFailed = reportCriticalCoverage(file, parsed, path.basename(absolutePath));\n    return result.invalid.length > 0 || result.failures.length > 0 || criticalFailed;\n}\n\nfunction runCli(args = process.argv.slice(2)) {\n    const files = args.length ? args : DEFAULT_REPORTS;\n    if (files.some(evaluateCoverageReport)) process.exitCode = 1;\n}`;
    content = replaceOnce(content, oldCli, newCli, "coverage CLI complexity and path validation");
    content = replaceOnce(
        content,
        `    percentage,\n    resolveThreshold`,
        `    percentage,\n    resolveCoverageReportPath,\n    resolveThreshold`,
        "coverage checker exports"
    );
    write(file, content);
}

function patchCoverageTests() {
    const file = "discord/tests/coverageThresholds.test.js";
    let content = read(file);
    content = replaceOnce(
        content,
        `const { evaluateCoverage, evaluateCriticalFiles, normalizeCoveragePath, parseLcov, percentage } = require("../../scripts/checkCoverageThresholds");`,
        `const { evaluateCoverage, evaluateCriticalFiles, normalizeCoveragePath, parseLcov, percentage, resolveCoverageReportPath } = require("../../scripts/checkCoverageThresholds");`,
        "coverage checker test imports"
    );
    const marker = `test("Voice coverage is scoped to the voice/session runtime instead of unrelated imports",`;
    const testBlock = `test("coverage report paths stay inside the repository and require LCOV files", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.\n    assert.equal(resolveCoverageReportPath("coverage/discord.lcov", "/tmp/repository"), "/tmp/repository/coverage/discord.lcov");\n    assert.throws(() => resolveCoverageReportPath("../outside.lcov", "/tmp/repository"), /escaped repository/);\n    assert.throws(() => resolveCoverageReportPath("coverage/report.json", "/tmp/repository"), /not LCOV/);\n});\n\n`;
    content = replaceOnce(content, marker, `${testBlock}${marker}`, "coverage report path tests");
    write(file, content);
}

function patchProtectedPaths() {
    const file = "scripts/checkProtectedPaths.js";
    let content = read(file);
    content = replaceOnce(
        content,
        `function isUsableBaseSha(value) {\n    if (!value || ZERO_SHA_PATTERN.test(value)) return false;`,
        `function isUsableBaseSha(value) {\n    if (!/^[a-f0-9]{40}$/i.test(String(value || "")) || ZERO_SHA_PATTERN.test(value)) return false;`,
        "protected base SHA validation"
    );
    content = replaceOnce(
        content,
        `        .filter(isProtectedPath)\n        .sort();`,
        `        .filter(isProtectedPath)\n        .sort((a, b) => a.localeCompare(b));`,
        "tracked protected file sorting"
    );
    content = replaceOnce(
        content,
        `    const manifestFiles = Object.keys(PROTECTED_DIGESTS).map(normalizeRepositoryPath).sort();`,
        `    const manifestFiles = Object.keys(PROTECTED_DIGESTS)\n        .map(normalizeRepositoryPath)\n        .sort((a, b) => a.localeCompare(b));`,
        "protected manifest sorting"
    );
    content = replaceOnce(
        content,
        `function readEventPayload() {\n    const eventPath = String(process.env.GITHUB_EVENT_PATH || "").trim();\n    if (!eventPath || !fs.existsSync(eventPath)) return null;\n    try {\n        return JSON.parse(fs.readFileSync(eventPath, "utf8"));\n    } catch {\n        return null;\n    }\n}`,
        `function readEventPayload() {\n    const eventPath = String(process.env.GITHUB_EVENT_PATH || "").trim();\n    if (!eventPath) return null;\n    const resolved = path.resolve(eventPath);\n    if (path.basename(resolved) !== "event.json") return null;\n    const runnerTemp = String(process.env.RUNNER_TEMP || "").trim();\n    if (process.env.CI && runnerTemp) {\n        const relative = path.relative(path.resolve(runnerTemp), resolved);\n        if (relative.startsWith("..") || path.isAbsolute(relative)) return null;\n    }\n    if (!fs.existsSync(resolved)) return null;\n    try {\n        return JSON.parse(fs.readFileSync(resolved, "utf8"));\n    } catch {\n        return null;\n    }\n}`,
        "bounded GitHub event payload path"
    );
    content = replaceOnce(
        content,
        `function ownerApprovalUrl(repository, pullNumber, page) {\n    const params = new URLSearchParams({\n        per_page: String(APPROVAL_PAGE_SIZE),\n        page: String(page),\n        sort: "created",\n        direction: "desc"\n    });\n    return \`https://api.github.com/repos/\${repository}/issues/\${pullNumber}/comments?\${params}\`;\n}`,
        `function validateRepositorySlug(repository) {\n    const value = String(repository || "").trim();\n    if (!/^[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+$/.test(value)) {\n        throw new Error("invalid GitHub repository slug");\n    }\n    return value;\n}\n\nfunction ownerApprovalUrl(repository, pullNumber, page) {\n    const safeRepository = validateRepositorySlug(repository);\n    if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) throw new Error("invalid pull request number");\n    if (!Number.isSafeInteger(page) || page <= 0 || page > APPROVAL_MAX_PAGES) throw new Error("invalid approval page");\n    const url = new URL(\`https://api.github.com/repos/\${safeRepository}/issues/\${pullNumber}/comments\`);\n    url.search = new URLSearchParams({\n        per_page: String(APPROVAL_PAGE_SIZE),\n        page: String(page),\n        sort: "created",\n        direction: "desc"\n    }).toString();\n    if (url.origin !== "https://api.github.com") throw new Error("invalid GitHub API origin");\n    return url.toString();\n}`,
        "fixed protected approval API origin"
    );
    content = replaceOnce(
        content,
        `async function fetchOwnerApproval({ repository, owner, pullNumber, headSha, token }) {\n    const marker = \`\${APPROVAL_MARKER_PREFIX}\${headSha} -->\`;`,
        `async function fetchOwnerApproval({ repository, owner, pullNumber, headSha, token }) {\n    validateRepositorySlug(repository);\n    if (!String(owner || "").trim()) throw new Error("invalid repository owner");\n    if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) throw new Error("invalid pull request number");\n    if (!/^[a-f0-9]{40}$/i.test(String(headSha || ""))) throw new Error("invalid protected head SHA");\n    if (!String(token || "").trim()) throw new Error("missing GitHub token");\n    const marker = \`\${APPROVAL_MARKER_PREFIX}\${headSha} -->\`;`,
        "protected approval request validation"
    );
    content = replaceOnce(
        content,
        `        .filter(isProtectedPath)\n        .sort();`,
        `        .filter(isProtectedPath)\n        .sort((a, b) => a.localeCompare(b));`,
        "changed protected path sorting"
    );
    write(file, content);
}

if (read("scripts/checkSecretLeaks.js").includes("function resolveTrackedPath")) {
    console.log("Final non-protected hardening is already applied.");
    process.exit(0);
}

patchVoiceLifecycle();
patchGuildRoute();
patchEvents();
patchOAuthLifecycle();
patchSecretScanner();
patchSecretTests();
patchDiscordCompatibility();
patchCoverageChecker();
patchCoverageTests();
patchProtectedPaths();
console.log("Applied final non-protected hardening.");
