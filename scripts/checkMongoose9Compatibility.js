#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");

const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const SOURCE_ROOT = fs.realpathSync(path.join(REPOSITORY_ROOT, "discord"));
const EXCLUDED_DIRECTORIES = new Set(["node_modules", "tests", "public", "views"]);
const REMOVED_CALLBACK_METHODS = new Set(["doValidate", "updateOne"]);

function ensureInsideSourceRoot(candidate) {
    const resolved = fs.realpathSync(candidate);
    const relative = path.relative(SOURCE_ROOT, resolved);
    const outside = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    if (outside) throw new Error(`Refusing to scan outside Discord source root: ${candidate}`);
    return resolved;
}

function walk(directory = SOURCE_ROOT) {
    const safeDirectory = ensureInsideSourceRoot(directory);
    const files = [];
    for (const entry of fs.readdirSync(safeDirectory, { withFileTypes: true })) {
        const safePath = ensureInsideSourceRoot(path.resolve(safeDirectory, entry.name));
        if (entry.isDirectory()) {
            if (!EXCLUDED_DIRECTORIES.has(entry.name)) files.push(...walk(safePath));
        } else if (entry.isFile() && entry.name.endsWith(".js")) {
            files.push(safePath);
        }
    }
    return files;
}

function parseSource(source, file) {
    try {
        return acorn.parse(source, {
            ecmaVersion: "latest",
            sourceType: "script",
            locations: true,
            allowHashBang: true,
            allowAwaitOutsideFunction: true
        });
    } catch (error) {
        error.message = `${file}:${error.loc?.line || 1} ${error.message}`;
        throw error;
    }
}

function walkAst(root, visitor) {
    const stack = [root];
    while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== "object") continue;
        if (typeof node.type === "string") visitor(node);
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) stack.push(...value);
            else if (value && typeof value === "object") stack.push(value);
        }
    }
}

function callbackParameterNames(node) {
    if (!node || !["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)) {
        return null;
    }
    return node.params.flatMap(parameterNames);
}

function parameterNames(node) {
    if (!node) return [];
    if (node.type === "Identifier") return [node.name];
    if (node.type === "AssignmentPattern") return parameterNames(node.left);
    if (node.type === "RestElement") return parameterNames(node.argument);
    return [];
}

function collectNamedCallbacks(ast) {
    const callbacks = new Map();
    walkAst(ast, node => {
        if (node.type === "FunctionDeclaration" && node.id?.name) callbacks.set(node.id.name, node);
        if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && callbackParameterNames(node.init)) {
            callbacks.set(node.id.name, node.init);
        }
    });
    return callbacks;
}

function memberMethodName(callee) {
    if (callee?.type !== "MemberExpression") return null;
    if (!callee.computed && callee.property?.type === "Identifier") return callee.property.name;
    if (callee.computed && callee.property?.type === "Literal") return String(callee.property.value);
    return null;
}

function resolveCallback(node, namedCallbacks) {
    if (callbackParameterNames(node)) return node;
    if (node?.type === "Identifier") return namedCallbacks.get(node.name) || null;
    return null;
}

function analyzeSource(source, file = "inline") {
    const ast = parseSource(source, file);
    const namedCallbacks = collectNamedCallbacks(ast);
    const findings = [];

    walkAst(ast, node => {
        if (node.type !== "CallExpression") return;
        const method = memberMethodName(node.callee);
        if (!method || method === "post") return;
        if (method !== "pre" && !REMOVED_CALLBACK_METHODS.has(method)) return;

        const callback = resolveCallback(node.arguments.at(-1), namedCallbacks);
        const parameters = callbackParameterNames(callback);
        if (!parameters) return;
        if (method === "pre" && !parameters.includes("next")) return;

        findings.push({
            file,
            line: node.loc?.start?.line || 1,
            code: method === "pre"
                ? "pre-middleware-next-callback"
                : method === "doValidate"
                    ? "doValidate-callback"
                    : "updateOne-callback"
        });
    });

    return findings;
}

function readSourceFile(file) {
    const safeFile = ensureInsideSourceRoot(file);
    return fs.readFileSync(safeFile, "utf8");
}

function scanRepository() {
    return walk().flatMap(file => analyzeSource(
        readSourceFile(file),
        path.relative(REPOSITORY_ROOT, file).replaceAll(path.sep, "/")
    ));
}

if (require.main === module) {
    const findings = scanRepository();
    if (findings.length) {
        console.error("[MONGOOSE9] Removed callback-style API patterns detected:");
        for (const item of findings) console.error(`- ${item.file}:${item.line} ${item.code}`);
        process.exitCode = 1;
    } else {
        console.log("[MONGOOSE9] Compatibility AST check passed");
    }
}

module.exports = { analyzeSource, scanRepository };
