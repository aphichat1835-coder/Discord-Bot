"use strict";

const fs = require("node:fs");
const path = require("node:path");

const EXCLUDED_DIRECTORIES = new Set(["node_modules", "tests", "public", "views"]);
const findings = [];

function walk(directory) {
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            if (!EXCLUDED_DIRECTORIES.has(entry.name)) files.push(...walk(fullPath));
        } else if (entry.isFile() && entry.name.endsWith(".js")) {
            files.push(fullPath);
        }
    }
    return files;
}

function lineAt(source, index) {
    return source.slice(0, index).split(/\r?\n/).length;
}

function record(file, source, code, match) {
    findings.push({ file, line: lineAt(source, match.index), code });
}

function scanMiddlewareCallbacks(file, source) {
    const functionHook = /\.(?:pre|post)\s*\(\s*(["'`])[^"'`]+\1\s*,\s*(?:\{[^}]*\}\s*,\s*)?(?:async\s+)?function\s*\(([^)]*)\)/gs;
    const arrowHook = /\.(?:pre|post)\s*\(\s*(["'`])[^"'`]+\1\s*,\s*(?:\{[^}]*\}\s*,\s*)?(?:async\s*)?\(([^)]*)\)\s*=>/gs;

    for (const pattern of [functionHook, arrowHook]) {
        let match;
        while ((match = pattern.exec(source))) {
            const parameters = String(match[2] || "")
                .split(",")
                .map(value => value.trim())
                .filter(Boolean);
            if (parameters.includes("next")) {
                record(file, source, "middleware-next-callback", match);
            }
        }
    }
}

function scanRemovedCallbackApis(file, source) {
    const rules = [
        ["doValidate-callback", /\.doValidate\s*\([^;]{0,500},\s*(?:function\b|\([^)]*\)\s*=>)/gs],
        ["updateOne-callback", /\.updateOne\s*\([^;]{0,800},\s*(?:function\b|\([^)]*\)\s*=>)\s*\)/gs]
    ];

    for (const [code, pattern] of rules) {
        let match;
        while ((match = pattern.exec(source))) record(file, source, code, match);
    }
}

for (const file of walk("discord")) {
    const source = fs.readFileSync(file, "utf8");
    scanMiddlewareCallbacks(file, source);
    scanRemovedCallbackApis(file, source);
}

if (findings.length) {
    console.error("[MONGOOSE9] Removed callback-style API patterns detected:");
    for (const item of findings) {
        console.error(`- ${item.file}:${item.line} ${item.code}`);
    }
    process.exitCode = 1;
} else {
    console.log("[MONGOOSE9] Compatibility pattern check passed");
}
