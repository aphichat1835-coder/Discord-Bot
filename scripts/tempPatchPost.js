#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");

function replaceOnce(file, search, replacement) {
    const absolute = path.join(root, file);
    const source = fs.readFileSync(absolute, "utf8");
    const first = source.indexOf(search);
    if (first < 0) throw new Error(`POST_PATCH_SOURCE_NOT_FOUND:${file}`);
    if (source.indexOf(search, first + search.length) >= 0) throw new Error(`POST_PATCH_SOURCE_NOT_UNIQUE:${file}`);
    fs.writeFileSync(absolute, source.slice(0, first) + replacement + source.slice(first + search.length));
}

replaceOnce(
    "discord/verification/utils/oauthTokenLifecycle.js",
`        try {
            await refreshOneOAuthUser(doc, {`,
`        try {
            const result = await refreshOneOAuthUser(doc, {`
);

console.log("[TEMP-PATCH] post-patch invariants applied");
