from __future__ import annotations

import ast
import re
from collections import defaultdict, deque
from pathlib import Path
from typing import Any

from .io_utils import SOURCE_SUFFIXES, read_text, relative, walk_files


SOURCE_PATTERNS = {
    "interaction_input": re.compile(r"\b(?:interaction|ctx|request|req)\b.*?(?:options|getString|getInteger|data|params|query|body)", re.I),
    "modal_or_custom_id": re.compile(r"\b(?:custom_?id|customId|fields|getTextInputValue)\b", re.I),
    "external_input": re.compile(r"\b(?:fetch|axios|requests\.(?:get|post)|aiohttp|webhook)\b", re.I),
}
SINK_PATTERNS = {
    "database_write": re.compile(r"\.(?:create|insert|update|delete|save|execute|commit)\s*\(", re.I),
    "dynamic_execution": re.compile(r"\b(?:eval|exec|Function)\s*\(", re.I),
    "filesystem_write": re.compile(r"\b(?:writeFile|write_text|open)\s*\(", re.I),
    "outbound_request": re.compile(r"\b(?:fetch|axios\.(?:post|put|patch)|requests\.(?:post|put|patch))\s*\(", re.I),
    "discord_effect": re.compile(r"\.(?:reply|send|send_message|editReply|followUp|ban|kick|timeout|add_roles|remove_roles)\s*\(", re.I),
}


def _module_target(path: Path, module: str, root: Path) -> str | None:
    if not module.startswith("."):
        return None
    base = path.parent
    candidate = (base / module).resolve()
    suffixes = sorted(SOURCE_SUFFIXES)
    for item in (candidate, *[candidate.with_suffix(s) for s in suffixes], *[(candidate / f"index{s}") for s in suffixes]):
        if item.is_file() and root.resolve() in item.parents:
            return relative(root, item)
    return None


def build_semantic_index(root: Path, max_files: int = 4000) -> dict[str, Any]:
    """Build a bounded cross-file evidence graph. It is heuristic, never formal taint proof."""
    files: dict[str, dict[str, Any]] = {}
    imports: list[dict[str, Any]] = []
    symbols: list[dict[str, Any]] = []
    flows: list[dict[str, Any]] = []
    for path in walk_files(root, suffixes=SOURCE_SUFFIXES, max_files=max_files):
        text = read_text(path)
        if text is None:
            continue
        rel = relative(root, path)
        file_symbols: list[str] = []
        if path.suffix == ".py":
            try:
                tree = ast.parse(text)
            except SyntaxError:
                tree = None
            if tree:
                for node in ast.walk(tree):
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                        file_symbols.append(node.name)
                        symbols.append({"id": f"{rel}:{node.name}", "path": rel, "name": node.name, "line": node.lineno, "basis": "python_ast"})
                    if isinstance(node, ast.ImportFrom) and node.module:
                        imports.append({"from": rel, "specifier": "." * node.level + node.module, "to": None, "basis": "python_ast"})
                    elif isinstance(node, ast.Import):
                        for alias in node.names:
                            imports.append({"from": rel, "specifier": alias.name, "to": None, "basis": "python_ast"})
        else:
            for match in re.finditer(r"(?:export\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)|(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=", text):
                name = match.group(1) or match.group(2)
                file_symbols.append(name)
                symbols.append({"id": f"{rel}:{name}", "path": rel, "name": name, "line": text.count("\n", 0, match.start()) + 1, "basis": "js_ts_syntax"})
            for match in re.finditer(r"(?:from\s+|require\s*\(\s*)[\"']([^\"']+)", text):
                specifier = match.group(1)
                imports.append({"from": rel, "specifier": specifier, "to": _module_target(path, specifier, root), "basis": "js_ts_syntax"})
        sources = [{"kind": name, "line": text.count("\n", 0, match.start()) + 1} for name, pattern in SOURCE_PATTERNS.items() for match in pattern.finditer(text)]
        sinks = [{"kind": name, "line": text.count("\n", 0, match.start()) + 1} for name, pattern in SINK_PATTERNS.items() for match in pattern.finditer(text)]
        for source in sources:
            for sink in sinks:
                if sink["line"] >= source["line"]:
                    flows.append({"path": rel, "source": source, "sink": sink, "confidence": "tentative", "basis": "same_file_source_order", "review": "Confirm variable identity, sanitization, authorization, and control flow."})
        files[rel] = {"symbols": file_symbols, "sources": sources, "sinks": sinks}
    reverse: dict[str, list[str]] = defaultdict(list)
    for edge in imports:
        if edge.get("to"):
            reverse[edge["to"]].append(edge["from"])
    return {
        "version": 3,
        "root": str(root.resolve()),
        "files": files,
        "symbols": symbols,
        "module_edges": imports,
        "reverse_dependencies": dict(sorted(reverse.items())),
        "candidate_flows": flows,
        "confidence": "structural_evidence",
        "limitations": ["Candidate flows are bounded review leads, not path-sensitive or interprocedural taint proof.", "Dynamic imports, reflection, dependency injection, generated code, aliases, and runtime dispatch may be unresolved.", "Use installed TypeScript compiler evidence, tests, logs, and runtime tracing for stronger claims."],
    }


def impact_slice(index: dict[str, Any], changed_paths: list[str], depth: int = 3) -> dict[str, Any]:
    reverse = index.get("reverse_dependencies", {})
    seen = set(changed_paths)
    queue = deque((path, 0) for path in changed_paths)
    edges: list[dict[str, Any]] = []
    while queue:
        target, level = queue.popleft()
        if level >= depth:
            continue
        for dependent in reverse.get(target, []):
            edges.append({"from": dependent, "to": target, "distance": level + 1})
            if dependent not in seen:
                seen.add(dependent)
                queue.append((dependent, level + 1))
    return {"changed": changed_paths, "affected": sorted(seen - set(changed_paths)), "edges": edges, "depth": depth, "claim": "bounded_static_dependency_slice"}
