#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const authPatchPath = path.join(__dirname, "tempPatchAuth.js");
let source = fs.readFileSync(authPatchPath, "utf8");
const marker = `replaceOnce(\n    "discord/systemProvider/dashboardHtml.js"`;
const first = source.indexOf(marker);
const second = source.indexOf(marker, first + marker.length);
if (first < 0 || second < 0) throw new Error("AUTH_PATCH_DASHBOARD_MARKERS_MISSING");
const secondEnd = source.indexOf("\n);", second);
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
source = source.slice(0, first) + replacement + source.slice(secondEnd + 3);
fs.writeFileSync(authPatchPath, source);
console.log("[TEMP-PATCH] patch scripts normalized");
