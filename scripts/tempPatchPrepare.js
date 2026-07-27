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

const operationsStart = authSource.indexOf("\nreplaceOnce(");
const finalLog = authSource.lastIndexOf('\nconsole.log("[TEMP-PATCH] protected auth remediation applied");');
if (operationsStart < 0 || finalLog < operationsStart) throw new Error("AUTH_PATCH_OPERATION_BOUNDARY_MISSING");
const prefix = authSource.slice(0, operationsStart);
const operations = authSource.slice(operationsStart, finalLog);
const suffix = authSource.slice(finalLog);
authSource = `${prefix}\ntry {${operations}\n} catch (error) {\n    fs.writeFileSync(path.join(root, ".github/temp-auth-error.txt"), String(error?.stack || error) + "\\n");\n    throw error;\n}${suffix}`;

fs.writeFileSync(authPatchPath, authSource);
console.log("[TEMP-PATCH] auth patch normalized");
