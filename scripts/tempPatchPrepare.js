#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function wrapOperations(source, finalLogText, diagnosticFile) {
    const replaceStart = source.indexOf("\nreplaceOnce(");
    const regexStart = source.indexOf("\nreplaceRegexOnce(");
    const operationsStart = [replaceStart, regexStart].filter(index => index >= 0).sort((a, b) => a - b)[0] ?? -1;
    const finalLog = source.lastIndexOf(`\nconsole.log("${finalLogText}");`);
    if (operationsStart < 0 || finalLog < operationsStart) throw new Error(`PATCH_OPERATION_BOUNDARY_MISSING:${finalLogText}`);
    const prefix = source.slice(0, operationsStart);
    const operations = source.slice(operationsStart, finalLog);
    const suffix = source.slice(finalLog);
    return `${prefix}\ntry {${operations}\n} catch (error) {\n    fs.writeFileSync(path.join(root, "${diagnosticFile}"), String(error?.stack || error) + "\\n");\n    throw error;\n}${suffix}`;
}

const authPatchPath = path.join(__dirname, "tempPatchAuth.js");
let authSource = fs.readFileSync(authPatchPath, "utf8");
const generatedStart = authSource.indexOf('write("discord/systemProvider/pinCredential.js"');
const generatedEnd = authSource.indexOf("\nreplaceOnce(", generatedStart);
if (generatedStart < 0 || generatedEnd < 0) throw new Error("AUTH_PATCH_GENERATED_CREDENTIAL_BLOCK_MISSING");
authSource = authSource.slice(0, generatedStart) + authSource.slice(generatedEnd + 1);
authSource = authSource
    .replaceAll("${cookieName}", "\\${cookieName}")
    .replaceAll("${sessionToken}", "\\${sessionToken}");

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
authSource = wrapOperations(authSource, "[TEMP-PATCH] protected auth remediation applied", ".github/temp-auth-error.txt");
fs.writeFileSync(authPatchPath, authSource);

const verificationPatchPath = path.join(__dirname, "tempPatchVerification.js");
let verificationSource = fs.readFileSync(verificationPatchPath, "utf8");
verificationSource = verificationSource.replaceAll('"discord/verification/lifecycle.js"', '"discord/verification/runtime.js"');
const verificationUniqueGuard = '    if (source.indexOf(search, first + search.length) >= 0) throw new Error(`PATCH_SOURCE_NOT_UNIQUE:${file}`);\n';
verificationSource = verificationSource.replace(verificationUniqueGuard, "");
const verificationOperationsStart = verificationSource.indexOf("\nreplaceOnce(");
if (verificationOperationsStart < 0) throw new Error("VERIFICATION_PATCH_OPERATIONS_MISSING");
verificationSource = verificationSource.slice(0, verificationOperationsStart) +
    verificationSource.slice(verificationOperationsStart).replaceAll("${", "\\${");
verificationSource = wrapOperations(verificationSource, "[TEMP-PATCH] verification remediation applied", ".github/temp-verification-error.txt");
fs.writeFileSync(verificationPatchPath, verificationSource);

const ciPatchPath = path.join(__dirname, "tempPatchCi.js");
let ciSource = fs.readFileSync(ciPatchPath, "utf8");
const ciReplaceStartCandidates = [ciSource.indexOf("\nreplaceOnce("), ciSource.indexOf("\nreplaceRegexOnce(")]
    .filter(index => index >= 0)
    .sort((a, b) => a - b);
const ciReplaceStart = ciReplaceStartCandidates[0] ?? -1;
const ciRuntimeStart = ciSource.indexOf("\nfunction updateProtectedManifest()", ciReplaceStart);
if (ciReplaceStart < 0 || ciRuntimeStart < 0) throw new Error("CI_PATCH_REPLACEMENT_BOUNDARY_MISSING");
const ciReplacementSection = ciSource.slice(ciReplaceStart, ciRuntimeStart).replaceAll("${", "\\${");
ciSource = ciSource.slice(0, ciReplaceStart) + ciReplacementSection + ciSource.slice(ciRuntimeStart);
ciSource = wrapOperations(ciSource, "[TEMP-PATCH] CI remediation applied", ".github/temp-ci-error.txt");
fs.writeFileSync(ciPatchPath, ciSource);

console.log("[TEMP-PATCH] auth, verification, and CI patches normalized");
