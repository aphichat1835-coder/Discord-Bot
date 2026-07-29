#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");

const DISCORD_ROOT = "discord";
const LEGACY_PERMISSION_PATTERN = /^[A-Z][A-Z_]+$/;

function walk(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const relative = path.join(directory, entry.name);
        if (relative === path.join(DISCORD_ROOT, "systemProvider")) return [];
        if (entry.isDirectory()) return walk(relative);
        return entry.isFile() && entry.name.endsWith(".js") ? [relative] : [];
    });
}

function propertyName(member) {
    if (!member?.computed && member?.property?.type === "Identifier") return member.property.name;
    if (member?.computed && member?.property?.type === "Literal") return member.property.value;
    return null;
}

function hasLegacyPermissionCall(node) {
    if (node?.type !== "CallExpression" || propertyName(node.callee) !== "has") return false;
    const firstArgument = node.arguments?.[0];
    return firstArgument?.type === "Literal" &&
        typeof firstArgument.value === "string" &&
        LEGACY_PERMISSION_PATTERN.test(firstArgument.value);
}

function walkAst(node, visit) {
    if (!node || typeof node !== "object") return;
    visit(node);
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(child => walkAst(child, visit));
        else if (value?.type) walkAst(value, visit);
    }
}

function functionBody(source, name) {
    const marker = `async function ${name}(`;
    const start = source.indexOf(marker);
    if (start < 0) return "";
    const braceStart = source.indexOf("{", start);
    let depth = 0;
    for (let index = braceStart; index < source.length; index += 1) {
        if (source[index] === "{") depth += 1;
        if (source[index] === "}") depth -= 1;
        if (depth === 0) return source.slice(braceStart, index + 1);
    }
    return "";
}

const findings = [];
const authSource = fs.readFileSync("discord/index/auth.js", "utf8");
const dashboardGuardSource = fs.readFileSync("discord/guards/dashboardGuards.js", "utf8");
if (!/req\.authenticatedByServerSecret\s*===\s*true/.test(authSource)) {
    findings.push("discord/index/auth.js: requireCsrf must trust only the verified request-local auth marker");
}
if (!/req\.authenticatedByServerSecret\s*=\s*false/.test(dashboardGuardSource) ||
    !/req\.authenticatedByServerSecret\s*=\s*true/.test(dashboardGuardSource)) {
    findings.push("discord/guards/dashboardGuards.js: server auth marker must be reset then set only after verification");
}
if (/hasServerAuthHeader|x-internal-secret/.test(authSource)) {
    findings.push("discord/index/auth.js: unverified auth-header CSRF bypass must not be reintroduced");
}

const saveDatabaseBody = functionBody(fs.readFileSync("discord/sessionManager.js", "utf8"), "saveDatabase");
if (!saveDatabaseBody || /deleteMany\s*\(\s*\{\s*\}\s*\)/.test(saveDatabaseBody)) {
    findings.push("discord/sessionManager.js: periodic saveDatabase must not delete all persisted sessions");
}

for (const file of walk(DISCORD_ROOT).filter(file =>
    file !== "discord/systemProvider.js" && !file.startsWith("discord/tests/")
)) {
    const source = fs.readFileSync(file, "utf8");
    let ast;
    try {
        ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "script", locations: true });
    } catch (error) {
        findings.push(`${file}: runtime-safety parser failed: ${error.message}`);
        continue;
    }

    walkAst(ast, node => {
        if (hasLegacyPermissionCall(node)) {
            findings.push(`${file}:${node.loc.start.line}: use PermissionFlagsBits instead of string permission names`);
        }
    });
}

if (findings.length) {
    console.error("[RUNTIME-SAFETY] regressions found:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exit(1);
}

console.log("[RUNTIME-SAFETY] CSRF, session persistence, and Discord permission guards verified.");
