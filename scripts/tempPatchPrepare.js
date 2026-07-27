#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const authPatchPath = path.join(__dirname, "tempPatchAuth.js");
let authSource = fs.readFileSync(authPatchPath, "utf8");
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
    if (count !== 2) throw new Error(\`PATCH_SOURCE_COUNT:\${file}:\${count}\`);
    write(file, dashboardSource.split(needle).join(replacementValue));
}`;
authSource = authSource.slice(0, first) + replacement + authSource.slice(secondEnd + 3);
fs.writeFileSync(authPatchPath, authSource);

const verificationPatchPath = path.join(__dirname, "tempPatchVerification.js");
let verificationSource = fs.readFileSync(verificationPatchPath, "utf8");
verificationSource = verificationSource.replace(
    `    if (source.indexOf(search, first + search.length) >= 0) throw new Error(\`PATCH_SOURCE_NOT_UNIQUE:\${file}\`);\n`,
    ""
);
verificationSource = verificationSource.replace(
    "            await refreshOneOAuthUser(doc, {",
    "            const result = await refreshOneOAuthUser(doc, {"
);
if (!verificationSource.includes("const result = await refreshOneOAuthUser")) {
    throw new Error("VERIFICATION_PATCH_RESULT_BINDING_MISSING");
}
fs.writeFileSync(verificationPatchPath, verificationSource);
console.log("[TEMP-PATCH] patch scripts normalized");
