#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const filename = path.resolve(__dirname, "applyFinalNonProtectedHardening.js");
let source = fs.readFileSync(filename, "utf8");

function replacePatchBlock(label, replacement) {
    const labelIndex = source.indexOf(`"${label}"`);
    const start = source.lastIndexOf("    content = replaceOnce(", labelIndex);
    const endMarker = "\n    );";
    const end = source.indexOf(endMarker, labelIndex);
    if (labelIndex === -1 || start === -1 || end === -1) {
        throw new Error(`Unable to locate patch block: ${label}`);
    }
    source = `${source.slice(0, start)}${replacement}${source.slice(end + endMarker.length)}`;
}

const walkStart = source.indexOf("    const oldWalk = `");
const walkEndMarker = "        \"Discord compatibility analyzeSource complexity\"\n    );";
const walkEnd = source.indexOf(walkEndMarker, walkStart);
if (walkStart === -1 || walkEnd === -1) {
    throw new Error("Unable to locate Discord compatibility patch block");
}

const walkReplacement = `    const walkStartMarker = \`    const findings = [];\\n    walk(ast, node => {\`;\n    const walkEndMarker = \`\\n\\n    const rawSource = String(source);\`;\n    const walkStart = content.indexOf(walkStartMarker);\n    const walkEnd = content.indexOf(walkEndMarker, walkStart);\n    if (walkStart === -1 || walkEnd === -1) {\n        throw new Error(\"Patch target not found: Discord compatibility analyzeSource complexity\");\n    }\n    content = \`\${content.slice(0, walkStart)}    const findings = [];\\n    walk(ast, node => inspectCompatibilityNode(node, findings));\${content.slice(walkEnd)}\`;`;
source = `${source.slice(0, walkStart)}${walkReplacement}${source.slice(walkEnd + walkEndMarker.length)}`;

replacePatchBlock("tracked protected file sorting", `    content = replaceOnce(\n        content,\n        \`    return splitLines(git([\"ls-files\", PROTECTED_ROOT_FILE, PROTECTED_DIRECTORY]))\\n        .map(normalizeRepositoryPath)\\n        .filter(isProtectedPath)\\n        .sort();\`,\n        \`    return splitLines(git([\"ls-files\", PROTECTED_ROOT_FILE, PROTECTED_DIRECTORY]))\\n        .map(normalizeRepositoryPath)\\n        .filter(isProtectedPath)\\n        .sort((a, b) => a.localeCompare(b));\`,\n        \"tracked protected file sorting\"\n    );`);

replacePatchBlock("changed protected path sorting", `    content = replaceOnce(\n        content,\n        \`    const protectedChanges = getChangedPaths()\\n        .map(normalizeRepositoryPath)\\n        .filter(isProtectedPath)\\n        .sort();\`,\n        \`    const protectedChanges = getChangedPaths()\\n        .map(normalizeRepositoryPath)\\n        .filter(isProtectedPath)\\n        .sort((a, b) => a.localeCompare(b));\`,\n        \"changed protected path sorting\"\n    );`);

fs.writeFileSync(filename, source, "utf8");
console.log("Repaired final hardening patcher.");
