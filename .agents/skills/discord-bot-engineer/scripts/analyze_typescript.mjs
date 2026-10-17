#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(process.argv[2] ?? '.');
let ts;
try {
  const requireFromProject = createRequire(path.join(root, 'package.json'));
  ts = requireFromProject('typescript');
} catch {
  try {
    const imported = await import('typescript');
    ts = imported.default ?? imported;
  } catch {
    console.log(JSON.stringify({ available: false, reason: 'typescript package is not installed in the project or Skill runtime', files: [], findings: [] }, null, 2));
    process.exit(0);
  }
}

const ignored = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.cache', '.venv', 'venv']);
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !ignored.has(entry.name)) walk(path.join(dir, entry.name));
    else if (entry.isFile() && /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) files.push(path.join(dir, entry.name));
  }
}

let options = { allowJs: true, checkJs: false, noEmit: true, target: ts.ScriptTarget.Latest, moduleResolution: ts.ModuleResolutionKind.NodeNext };
let rootFiles;
const configDiagnostics = [];
const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
if (configPath) {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    configDiagnostics.push(config.error);
  } else {
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
    options = { ...parsed.options, noEmit: true };
    rootFiles = parsed.fileNames;
    configDiagnostics.push(...parsed.errors);
  }
}
if (!rootFiles) {
  walk(root);
  rootFiles = files;
}
const selectedFiles = rootFiles.slice(0, 4000);
const program = ts.createProgram(selectedFiles, options);
const checker = program.getTypeChecker();
const relative = file => path.relative(root, file).split(path.sep).join('/');
const responsePattern = /\.(?:reply|deferReply|editReply|followUp|update|deferUpdate|send_message|defer|edit_original_response)$/;
const sideEffectPattern = /\.(?:create|delete|destroy|save|update|execute|commit)$/;
const result = [];
const callEdges = [];
const findings = [];

function lineOf(source, node) {
  const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { line: pos.line + 1, character: pos.character + 1 };
}

function functionName(node, source) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      if (current.name) return current.name.getText(source);
      if (current.parent && ts.isVariableDeclaration(current.parent)) return current.parent.name.getText(source);
      return '<anonymous>';
    }
    current = current.parent;
  }
  return '<module>';
}

for (const source of program.getSourceFiles()) {
  if (source.isDeclarationFile || !source.fileName.startsWith(root) || source.fileName.includes(`${path.sep}node_modules${path.sep}`)) continue;
  const imports = [];
  const functions = new Map();
  function functionRecord(name) {
    if (!functions.has(name)) functions.set(name, { name, response_calls: [], side_effect_calls: [], branches: 0, returns: 0 });
    return functions.get(name);
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    const owner = functionRecord(functionName(node, source));
    if (ts.isIfStatement(node) || ts.isConditionalExpression(node) || ts.isSwitchStatement(node)) owner.branches += 1;
    if (ts.isReturnStatement(node)) owner.returns += 1;
    if (ts.isCallExpression(node)) {
      const expression = node.expression.getText(source);
      const location = lineOf(source, node);
      if (responsePattern.test(expression)) owner.response_calls.push({ expression, ...location });
      if (sideEffectPattern.test(expression)) owner.side_effect_calls.push({ expression, ...location });
      const symbol = checker.getSymbolAtLocation(node.expression);
      const declaration = symbol?.declarations?.[0];
      if (declaration && declaration.getSourceFile().fileName.startsWith(root)) {
        callEdges.push({ from: `${relative(source.fileName)}:${functionName(node, source)}`, to: `${relative(declaration.getSourceFile().fileName)}:${symbol.getName()}`, line: location.line, basis: 'typescript_symbol' });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const item of functions.values()) {
    if (item.response_calls.length > 1) findings.push({ severity: 'review', rule: 'multiple_response_calls_in_function', path: relative(source.fileName), line: item.response_calls[0].line, function: item.name, confidence: 'strong_inference', message: 'Multiple interaction response calls share a function; inspect mutually exclusive control-flow and terminal returns.' });
    const firstEffect = item.side_effect_calls[0];
    const firstResponse = item.response_calls[0];
    if (firstEffect && (!firstResponse || firstEffect.line < firstResponse.line)) findings.push({ severity: 'review', rule: 'side_effect_before_visible_response', path: relative(source.fileName), line: firstEffect.line, function: item.name, confidence: 'tentative', message: 'A side effect appears before the first visible interaction response in lexical order; confirm acknowledgement and authorization paths.' });
  }
  result.push({ path: relative(source.fileName), imports: [...new Set(imports)].sort(), functions: [...functions.values()].filter(item => item.name !== '<module>' || item.response_calls.length || item.side_effect_calls.length) });
}

const diagnostics = [...configDiagnostics, ...ts.getPreEmitDiagnostics(program)].slice(0, 200).map(diagnostic => {
  const source = diagnostic.file;
  const location = source && diagnostic.start !== undefined ? source.getLineAndCharacterOfPosition(diagnostic.start) : null;
  return { code: diagnostic.code, category: ts.DiagnosticCategory[diagnostic.category], path: source ? relative(source.fileName) : null, line: location ? location.line + 1 : null, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') };
});

console.log(JSON.stringify({ available: true, parser: 'typescript-program-and-type-checker', config: configPath ? relative(configPath) : null, discovered_files: rootFiles.length, analyzed_file_limit: 4000, truncated: rootFiles.length > selectedFiles.length, files: result, graphs: { calls: callEdges }, diagnostics, findings, limitations: ['Multiple response findings still require path-sensitive confirmation; the compiler graph is symbol-based, not full taint analysis.'] }, null, 2));
