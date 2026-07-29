#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const filename = path.resolve(__dirname, "applyFinalNonProtectedHardening.js");
let source = fs.readFileSync(filename, "utf8");

const start = source.indexOf("    const oldWalk = `");
const endMarker = "        \"Discord compatibility analyzeSource complexity\"\n    );";
const end = source.indexOf(endMarker, start);
if (start === -1 || end === -1) {
    throw new Error("Unable to locate Discord compatibility patch block");
}

const replacement = `    const walkStartMarker = \`    const findings = [];\\n    walk(ast, node => {\`;\n    const walkEndMarker = \`\\n\\n    const rawSource = String(source);\`;\n    const walkStart = content.indexOf(walkStartMarker);\n    const walkEnd = content.indexOf(walkEndMarker, walkStart);\n    if (walkStart === -1 || walkEnd === -1) {\n        throw new Error(\"Patch target not found: Discord compatibility analyzeSource complexity\");\n    }\n    content = \`\${content.slice(0, walkStart)}    const findings = [];\\n    walk(ast, node => inspectCompatibilityNode(node, findings));\${content.slice(walkEnd)}\`;`;

source = `${source.slice(0, start)}${replacement}${source.slice(end + endMarker.length)}`;
fs.writeFileSync(filename, source, "utf8");
console.log("Repaired final hardening patcher.");
