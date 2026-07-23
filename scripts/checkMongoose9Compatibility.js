#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const acorn = require("acorn");

const REMOVED_CALLBACK_METHODS = new Set(["doValidate", "updateOne"]);

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

function findingCode(method) {
    if (method === "pre") return "pre-middleware-next-callback";
    if (method === "doValidate") return "doValidate-callback";
    return "updateOne-callback";
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
            code: findingCode(method)
        });
    });

    return findings;
}

function normalizedFileLabel(value) {
    const label = String(value || "stdin")
        .replace(/[\r\n\t]+/g, " ")
        .trim();
    return label.slice(0, 300) || "stdin";
}

function runCli() {
    const file = normalizedFileLabel(process.argv[2]);
    const source = fs.readFileSync(0, "utf8");
    const findings = analyzeSource(source, file);
    if (!findings.length) return;

    console.error("[MONGOOSE9] Removed callback-style API patterns detected:");
    for (const item of findings) console.error(`- ${item.file}:${item.line} ${item.code}`);
    process.exitCode = 1;
}

if (require.main === module) runCli();

module.exports = { analyzeSource };
