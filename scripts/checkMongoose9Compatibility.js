"use strict";

const fs = require("node:fs");
const path = require("node:path");

const EXCLUDED_DIRECTORIES = new Set(["node_modules", "tests", "public", "views"]);

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

function findClosingParenthesis(source, openingIndex) {
    let depth = 0;
    let quote = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;

    for (let index = openingIndex; index < source.length; index++) {
        const character = source[index];
        const next = source[index + 1];

        if (lineComment) {
  if (character === "\n") lineComment = false;
  continue;
        }
        if (blockComment) {
  if (character === "*" && next === "/") {
      blockComment = false;
      index++;
  }
  continue;
        }
        if (quote) {
  if (escaped) escaped = false;
  else if (character === "\\") escaped = true;
  else if (character === quote) quote = null;
  continue;
        }
        if (character === "/" && next === "/") {
  lineComment = true;
  index++;
  continue;
        }
        if (character === "/" && next === "*") {
  blockComment = true;
  index++;
  continue;
        }
        if (character === '"' || character === "'" || character === "`") {
  quote = character;
  continue;
        }
        if (character === "(") depth++;
        else if (character === ")") {
  depth--;
  if (depth === 0) return index;
        }
    }
    return -1;
}

function splitTopLevelArguments(source) {
    const argumentsList = [];
    let start = 0;
    let round = 0;
    let square = 0;
    let curly = 0;
    let quote = null;
    let escaped = false;

    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        if (quote) {
  if (escaped) escaped = false;
  else if (character === "\\") escaped = true;
  else if (character === quote) quote = null;
  continue;
        }
        if (character === '"' || character === "'" || character === "`") {
  quote = character;
  continue;
        }
        if (character === "(") round++;
        else if (character === ")") round--;
        else if (character === "[") square++;
        else if (character === "]") square--;
        else if (character === "{") curly++;
        else if (character === "}") curly--;
        else if (character === "," && round === 0 && square === 0 && curly === 0) {
  argumentsList.push(source.slice(start, index).trim());
  start = index + 1;
        }
    }
    argumentsList.push(source.slice(start).trim());
    return argumentsList.filter(Boolean);
}

function callbackParameters(expression) {
    const value = String(expression || "").trim();
    let match = value.match(/^(?:async\s+)?function(?:\s+[A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/);
    if (!match) match = value.match(/^(?:async\s*)?\(([^)]*)\)\s*=>/);
    if (match) return match[1].split(",").map(item => item.trim()).filter(Boolean);
    match = value.match(/^(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/);
    return match ? [match[1]] : null;
}

function findMethodCalls(source) {
    const calls = [];
    const methodPattern = /\.(pre|post|doValidate|updateOne)\s*\(/g;
    let match;
    while ((match = methodPattern.exec(source))) {
        const openingIndex = source.indexOf("(", match.index);
        const closingIndex = findClosingParenthesis(source, openingIndex);
        if (closingIndex < 0) continue;
        calls.push({
  method: match[1],
  index: match.index,
  args: splitTopLevelArguments(source.slice(openingIndex + 1, closingIndex))
        });
        methodPattern.lastIndex = closingIndex + 1;
    }
    return calls;
}

function analyzeSource(source, file = "inline") {
    const findings = [];
    for (const call of findMethodCalls(source)) {
        if (call.method === "pre") {
  const parameters = callbackParameters(call.args.at(-1));
  if (parameters?.includes("next")) {
      findings.push({ file, line: lineAt(source, call.index), code: "pre-middleware-next-callback" });
  }
  continue;
        }
        if (call.method === "post") continue;
        const parameters = callbackParameters(call.args.at(-1));
        if (!parameters) continue;
        findings.push({
  file,
  line: lineAt(source, call.index),
  code: call.method === "doValidate" ? "doValidate-callback" : "updateOne-callback"
        });
    }
    return findings;
}

function scanRepository(root = "discord") {
    return walk(root).flatMap(file => analyzeSource(fs.readFileSync(file, "utf8"), file));
}

if (require.main === module) {
    const findings = scanRepository();
    if (findings.length) {
        console.error("[MONGOOSE9] Removed callback-style API patterns detected:");
        for (const item of findings) console.error(`- ${item.file}:${item.line} ${item.code}`);
        process.exitCode = 1;
    } else {
        console.log("[MONGOOSE9] Compatibility pattern check passed");
    }
}

module.exports = {
    analyzeSource,
    callbackParameters,
    findMethodCalls,
    splitTopLevelArguments
};
