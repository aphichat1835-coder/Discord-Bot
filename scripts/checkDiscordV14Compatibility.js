#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");

const LEGACY_PERMISSION_KEYS = new Set([
    "CREATE_INSTANT_INVITE",
    "KICK_MEMBERS",
    "BAN_MEMBERS",
    "ADMINISTRATOR",
    "MANAGE_CHANNELS",
    "MANAGE_GUILD",
    "ADD_REACTIONS",
    "VIEW_AUDIT_LOG",
    "PRIORITY_SPEAKER",
    "STREAM",
    "VIEW_CHANNEL",
    "SEND_MESSAGES",
    "SEND_TTS_MESSAGES",
    "MANAGE_MESSAGES",
    "EMBED_LINKS",
    "ATTACH_FILES",
    "READ_MESSAGE_HISTORY",
    "MENTION_EVERYONE",
    "USE_EXTERNAL_EMOJIS",
    "VIEW_GUILD_INSIGHTS",
    "CONNECT",
    "SPEAK",
    "MUTE_MEMBERS",
    "DEAFEN_MEMBERS",
    "MOVE_MEMBERS",
    "USE_VAD",
    "CHANGE_NICKNAME",
    "MANAGE_NICKNAMES",
    "MANAGE_ROLES",
    "MANAGE_WEBHOOKS",
    "MANAGE_EMOJIS_AND_STICKERS",
    "MODERATE_MEMBERS"
]);

function propertyName(node) {
    if (!node) return null;
    if (!node.computed && node.property?.type === "Identifier") return node.property.name;
    if (node.property?.type === "Literal") return String(node.property.value);
    return null;
}

function literalString(node) {
    return node?.type === "Literal" && typeof node.value === "string" ? node.value : null;
}

function objectPropertyName(node) {
    if (!node || node.type !== "Property") return null;
    if (!node.computed && node.key?.type === "Identifier") return node.key.name;
    if (node.key?.type === "Literal") return String(node.key.value);
    return null;
}

function walk(node, visitor, parent = null) {
    if (!node || typeof node !== "object") return;
    visitor(node, parent);
    for (const [key, value] of Object.entries(node)) {
        if (key === "loc" || key === "start" || key === "end") continue;
        if (Array.isArray(value)) {
            for (const child of value) {
                if (child && typeof child.type === "string") walk(child, visitor, node);
            }
        } else if (value && typeof value.type === "string") {
            walk(value, visitor, node);
        }
    }
}

function isReqQueryPin(node) {
    if (node?.type !== "MemberExpression" || propertyName(node) !== "pin") return false;
    const query = node.object;
    return query?.type === "MemberExpression" && propertyName(query) === "query" &&
        query.object?.type === "Identifier" && query.object.name === "req";
}

function isDirectChannelCacheClear(node) {
    if (node?.type !== "CallExpression" || propertyName(node.callee) !== "clear") return false;
    const cache = node.callee.object;
    const channels = cache?.type === "MemberExpression" && propertyName(cache) === "cache" ? cache.object : null;
    return channels?.type === "MemberExpression" && propertyName(channels) === "channels";
}

function finding(code, message, node) {
    return {
        code,
        message,
        line: node?.loc?.start?.line || 1,
        column: node?.loc?.start?.column || 0
    };
}

function analyzeSource(source, filename = "source.js") {
    let ast;
    try {
        ast = acorn.parse(String(source), {
            ecmaVersion: "latest",
            sourceType: "script",
            allowHashBang: true,
            locations: true
        });
    } catch (error) {
        return [{
            code: "PARSE_ERROR",
            message: `${filename}: ${error.message}`,
            line: error.loc?.line || 1,
            column: error.loc?.column || 0
        }];
    }

    const findings = [];
    walk(ast, node => {
        if (node.type === "CallExpression") {
            const method = propertyName(node.callee);
            if (method === "has") {
                const permission = literalString(node.arguments?.[0]);
                if (permission && LEGACY_PERMISSION_KEYS.has(permission)) {
                    findings.push(finding(
                        "LEGACY_PERMISSION_HAS",
                        `Use PermissionFlagsBits instead of .has(\"${permission}\")`,
                        node
                    ));
                }
            }
            if (method === "isText") {
                findings.push(finding("DEPRECATED_IS_TEXT", "Use isTextBased()/isSendable() instead of isText()", node));
            }
            if (method === "all" && node.callee.object?.type === "Identifier" && node.callee.object.name === "app") {
                findings.push(finding("STATE_ROUTE_APP_ALL", "Use explicit HTTP methods instead of app.all()", node));
            }
            if (isDirectChannelCacheClear(node)) {
                findings.push(finding("DIRECT_CHANNEL_CACHE_CLEAR", "Do not clear the Discord channel cache directly", node));
            }
        }

        if (node.type === "Property") {
            const key = objectPropertyName(node);
            if (key && LEGACY_PERMISSION_KEYS.has(key)) {
                findings.push(finding(
                    "LEGACY_PERMISSION_OBJECT_KEY",
                    `Use the canonical Discord.js v14 permission key instead of ${key}`,
                    node
                ));
            }
        }

        if (isReqQueryPin(node)) {
            findings.push(finding("QUERY_PIN", "Credentials must never be accepted from req.query.pin", node));
        }
    });

    const rawSource = String(source);
    const unsafeOriginPattern = /\.startsWith\(\s*window\.location\.origin\s*\)/g;
    for (const match of rawSource.matchAll(unsafeOriginPattern)) {
        const line = rawSource.slice(0, match.index).split(/\r?\n/).length;
        findings.push({
            code: "UNSAFE_SAME_ORIGIN_PREFIX",
            message: "Compare parsed URL origins for exact equality",
            line,
            column: 0
        });
    }
    return findings;
}

function listJavaScriptFiles(root) {
    const output = [];
    function visit(current) {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const fullPath = path.join(current, entry.name);
            const relative = fullPath.replaceAll("\\", "/");
            if (entry.isDirectory()) {
                if (entry.name === "tests" || entry.name === "node_modules" || entry.name === "coverage") continue;
                visit(fullPath);
            } else if (entry.isFile() && entry.name.endsWith(".js")) {
                output.push(relative);
            }
        }
    }
    if (fs.existsSync(root)) visit(root);
    return output.sort();
}

function runCli() {
    const files = listJavaScriptFiles("discord");
    const allFindings = [];
    for (const file of files) {
        const source = fs.readFileSync(file, "utf8");
        for (const item of analyzeSource(source, file)) allFindings.push({ file, ...item });
    }

    if (!allFindings.length) {
        console.log(`[DISCORD14] checked ${files.length} production JavaScript files; no legacy runtime patterns found.`);
        return;
    }

    for (const item of allFindings) {
        console.error(`[DISCORD14] ${item.file}:${item.line}:${item.column} ${item.code} ${item.message}`);
    }
    process.exitCode = 1;
}

if (require.main === module) runCli();

module.exports = {
    LEGACY_PERMISSION_KEYS,
    analyzeSource,
    isDirectChannelCacheClear,
    isReqQueryPin,
    listJavaScriptFiles
};
