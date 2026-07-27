#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const authPatchPath = path.join(__dirname, "tempPatchAuth.js");
let authSource = fs.readFileSync(authPatchPath, "utf8");

const generatedStart = authSource.indexOf('write("discord/systemProvider/pinCredential.js"');
const generatedEnd = authSource.indexOf("\nreplaceOnce(", generatedStart);
if (generatedStart < 0 || generatedEnd < 0) throw new Error("AUTH_PATCH_GENERATED_CREDENTIAL_BLOCK_MISSING");
authSource = authSource.slice(0, generatedStart) + authSource.slice(generatedEnd + 1);

const oldMissingGuard = '    if (first < 0) throw new Error(`PATCH_SOURCE_NOT_FOUND:${file}`);';
const newMissingGuard = `    if (first < 0) {
        fs.writeFileSync(path.join(root, ".github/temp-auth-error.txt"), [
            \`file=\${file}\`,
            \`search=\${String(search).slice(0, 500)}\`
        ].join("\\n") + "\\n");
        throw new Error(\`PATCH_SOURCE_NOT_FOUND:\${file}\`);
    }`;
if (!authSource.includes(oldMissingGuard)) throw new Error("AUTH_PATCH_MISSING_GUARD_NOT_FOUND");
authSource = authSource.replace(oldMissingGuard, newMissingGuard);

const oldUniqueGuard = '    if (source.indexOf(search, first + search.length) >= 0) throw new Error(`PATCH_SOURCE_NOT_UNIQUE:${file}`);';
const newUniqueGuard = `    if (source.indexOf(search, first + search.length) >= 0) {
        fs.writeFileSync(path.join(root, ".github/temp-auth-error.txt"), [
            \`file=\${file}\`,
            "error=source_not_unique",
            \`search=\${String(search).slice(0, 500)}\`
        ].join("\\n") + "\\n");
        throw new Error(\`PATCH_SOURCE_NOT_UNIQUE:\${file}\`);
    }`;
if (!authSource.includes(oldUniqueGuard)) throw new Error("AUTH_PATCH_UNIQUE_GUARD_NOT_FOUND");
authSource = authSource.replace(oldUniqueGuard, newUniqueGuard);

const marker = `replaceOnce(\n    "discord/systemProvider/dashboardHtml.js"`;
const first = authSource.indexOf(marker);
const second = authSource.indexOf(marker, first + marker.length);
if (first < 0 || second < 0) throw new Error("AUTH_PATCH_DASHBOARD_MARKERS_MISSING");
const secondEnd = authSource.indexOf("\n);", second);
if (secondEnd < 0) throw new Error("AUTH_PATCH_DASHBOARD_BLOCK_END_MISSING");
const replacement = `{
    const file = "discord/systemProvider/dashboardHtml.js";
    const dashboardSource = read(file);
    const needle = "'x-csrf-token':readCookie('__da_csrf')";
    const replacementValue = "'x-csrf-token':readCookie('__shadow_console_csrf')";
    const count = dashboardSource.split(needle).length - 1;
    if (count !== 2) {
        fs.writeFileSync(path.join(root, ".github/temp-auth-error.txt"), \`file=\${file}\\nerror=csrf_source_count_\${count}\\n\`);
        throw new Error(\`PATCH_SOURCE_COUNT:\${file}:\${count}\`);
    }
    write(file, dashboardSource.split(needle).join(replacementValue));
}`;
authSource = authSource.slice(0, first) + replacement + authSource.slice(secondEnd + 3);
fs.writeFileSync(authPatchPath, authSource);
console.log("[TEMP-PATCH] auth patch normalized");
