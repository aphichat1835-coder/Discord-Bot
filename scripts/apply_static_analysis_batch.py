#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path.cwd()


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match, found {count}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


scanner = r'''#!/usr/bin/env node
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
'''
(ROOT / "scripts/checkMongoose9Compatibility.js").write_text(scanner, encoding="utf-8")

shell = r'''#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

status=0
while IFS= read -r -d '' file; do
    if ! node scripts/checkMongoose9Compatibility.js "$file" < "$file"; then
        status=1
    fi
done < <(
    find discord \
        -type d \( -name node_modules -o -name tests -o -name public -o -name views \) -prune -o \
        -type f -name '*.js' -print0
)

if (( status != 0 )); then
    exit "$status"
fi

echo "[MONGOOSE9] Compatibility AST check passed"
'''
shell_path = ROOT / "scripts/checkMongoose9Compatibility.sh"
shell_path.write_text(shell, encoding="utf-8")
shell_path.chmod(0o755)

package_path = ROOT / "package.json"
package = json.loads(package_path.read_text(encoding="utf-8"))
package["scripts"]["check:scripts"] = (
    "find scripts -type f -name '*.js' -print0 | xargs -0 -n1 node --check "
    "&& find scripts -type f -name '*.sh' -print0 | xargs -0 -r -n1 bash -n"
)
package["scripts"]["check:mongoose9"] = "bash scripts/checkMongoose9Compatibility.sh"
package_path.write_text(json.dumps(package, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

replace_once(
    "discord/sessionManager.js",
    '''    for (let index = 0; index < value.length; index++) {\n        const code = value.charCodeAt(index);\n        const allowedWhitespace = code === 9 || code === 10 || code === 13;\n        if ((code < 32 && !allowedWhitespace) || code === 127) return false;\n    }''',
    '''    for (const character of value) {\n        const code = character.codePointAt(0);\n        const allowedWhitespace = code === 9 || code === 10 || code === 13;\n        if ((code < 32 && !allowedWhitespace) || code === 127) return false;\n    }'''
)

mongoose_test_path = ROOT / "discord/tests/mongoose9Compatibility.test.js"
mongoose_test = mongoose_test_path.read_text(encoding="utf-8")
replace_marker = 'const test = require("node:test");\n'
if mongoose_test.count(replace_marker) != 1:
    raise RuntimeError("mongoose9Compatibility.test.js: unexpected import marker")
mongoose_test = mongoose_test.replace(
    replace_marker,
    replace_marker + 'const { spawnSync } = require("node:child_process");\n',
    1
)
cli_test = r'''

test("Mongoose 9 CLI scanner reads source from stdin instead of opening dynamic paths", () => {
    const scanner = require.resolve("../../scripts/checkMongoose9Compatibility");
    const blocked = spawnSync(process.execPath, [scanner, "discord/models/Example.js"], {
        input: 'schema.pre("save", function(next) { next(); });',
        encoding: "utf8"
    });
    const clean = spawnSync(process.execPath, [scanner, "discord/models/Example.js"], {
        input: 'schema.pre("save", async function() { await work(); });',
        encoding: "utf8"
    });

    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /discord\/models\/Example\.js:1 pre-middleware-next-callback/);
    assert.equal(clean.status, 0);
    assert.equal(clean.stderr, "");
});
'''
if "CLI scanner reads source from stdin" in mongoose_test:
    raise RuntimeError("mongoose CLI regression test already exists")
mongoose_test_path.write_text(mongoose_test.rstrip() + cli_test, encoding="utf-8")

session_test_path = ROOT / "discord/tests/sessionEncryption.test.js"
session_test = session_test_path.read_text(encoding="utf-8")
unicode_test = r'''

test("Voice token plausibility accepts printable Unicode code points", (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    t.assert.equal(sessionManager._test.isPlausiblePlaintext("voice-token-🔐"), true);
});
'''
if "printable Unicode code points" in session_test:
    raise RuntimeError("Unicode plausibility regression test already exists")
session_test_path.write_text(session_test.rstrip() + unicode_test, encoding="utf-8")

replace_once(
    "CHANGELOG.md",
    "## [Unreleased] - Unified Bot And Verification Runtime 2026-07-16\n\n",
    "## [Unreleased] - Unified Bot And Verification Runtime 2026-07-16\n\n"
    "- Removed JavaScript-side dynamic path construction from the Mongoose 9 compatibility gate by feeding fixed-root source files over stdin, added CLI regression coverage, simplified finding classification, and updated Voice plaintext validation to iterate Unicode code points.\n\n"
)

print("static-analysis batch applied")
