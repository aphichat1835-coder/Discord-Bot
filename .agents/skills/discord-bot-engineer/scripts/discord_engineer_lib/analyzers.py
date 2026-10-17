from __future__ import annotations

import ast
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from .io_utils import SOURCE_SUFFIXES, read_text, relative, walk_files


@dataclass
class Finding:
    severity: str
    rule: str
    path: str
    line: int
    message: str
    confidence: str = "tentative"
    evidence: str = "structural"


def _add(items: list[Finding], path: str, text: str, match: re.Match[str], severity: str, rule: str, message: str, confidence: str = "tentative") -> None:
    items.append(Finding(severity, rule, path, text.count("\n", 0, match.start()) + 1, message, confidence))


def analyze_project(root: Path, kinds: set[str] | None = None, max_files: int = 4000) -> dict[str, Any]:
    kinds = kinds or {"security", "interaction", "authorization", "lifecycle", "impact"}
    findings: list[Finding] = []
    edges: dict[str, list[dict[str, Any]]] = {name: [] for name in ("interaction", "authorization", "lifecycle", "impact", "calls", "imports")}
    symbols: list[dict[str, Any]] = []
    scanned = 0
    rules = [
        ("security", "error", "secret_literal", re.compile(r"(?i)\b(?:discord_?token|bot_?token|client_?secret)\b\s*[:=]\s*[rubf]*[\"'][^\"']{16,}[\"']"), "Possible credential literal; remove and rotate if real."),
        ("security", "warning", "mass_mention", re.compile(r"allowed_mentions\s*=\s*(?:None|True)|allowedMentions\s*:\s*\{?\s*parse\s*:\s*\[[^\]]*(?:everyone|roles)"), "Broad mention policy may allow unintended mass mentions."),
        ("lifecycle", "warning", "blocking_sleep", re.compile(r"\btime\.sleep\s*\("), "Blocking sleep may stall the Discord event loop."),
        ("lifecycle", "warning", "unbounded_collector", re.compile(r"createMessageComponentCollector\s*\(\s*\{(?:(?!\b(?:time|idle)\s*:).){0,800}\}", re.S), "Collector has no visible time/idle bound."),
        ("interaction", "info", "response_call", re.compile(r"\.(?:reply|deferReply|editReply|followUp|update|deferUpdate|send_message|defer|edit_original_response)\s*\("), "Interaction response transition found."),
        ("authorization", "info", "permission_check", re.compile(r"PermissionFlagsBits|PermissionsBitField|has_permissions|bot_has_permissions"), "Permission check found; verify actor, bot, hierarchy, and fresh state."),
        ("impact", "info", "external_write", re.compile(r"\.(?:create|delete|destroy|save|update|execute|commit)\s*\("), "Potential side effect; trace idempotency, partial failure, and rollback."),
    ]
    for path in walk_files(root, suffixes=SOURCE_SUFFIXES, max_files=max_files):
        text = read_text(path)
        if text is None:
            continue
        scanned += 1
        rel = relative(root, path)
        if path.suffix == ".py":
            try:
                tree = ast.parse(text)
                for node in ast.walk(tree):
                    if isinstance(node, (ast.Import, ast.ImportFrom)):
                        names = [alias.name for alias in node.names]
                        edges["imports"].append({"path": rel, "modules": names, "line": node.lineno, "basis": "python_ast"})
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        decorators = [ast.unparse(item) for item in node.decorator_list]
                        response_calls: list[dict[str, Any]] = []
                        side_effect_calls: list[dict[str, Any]] = []
                        for child in ast.walk(node):
                            if not isinstance(child, ast.Call):
                                continue
                            target = ast.unparse(child.func)
                            edges["calls"].append({"path": rel, "from": node.name, "to": target, "line": child.lineno, "basis": "python_ast"})
                            if re.search(r"\.(?:send_message|defer|edit_original_response|send|reply)$", target):
                                response_calls.append({"target": target, "line": child.lineno})
                            if re.search(r"\.(?:create|delete|save|update|execute|commit)$", target):
                                side_effect_calls.append({"target": target, "line": child.lineno})
                        symbol = {"path": rel, "name": node.name, "kind": "async_function" if isinstance(node, ast.AsyncFunctionDef) else "function", "line": node.lineno, "decorators": decorators, "response_calls": response_calls, "side_effect_calls": side_effect_calls}
                        symbols.append(symbol)
                        if len(response_calls) > 1 and "interaction" in kinds:
                            findings.append(Finding("warning", "multiple_response_calls_in_function", rel, node.lineno, f"{node.name} contains multiple response calls; confirm mutually exclusive control-flow and terminal returns.", "strong_inference", "python_ast"))
                        if side_effect_calls and (not response_calls or side_effect_calls[0]["line"] < response_calls[0]["line"]) and "impact" in kinds:
                            findings.append(Finding("warning", "side_effect_before_visible_response", rel, side_effect_calls[0]["line"], f"{node.name} has a side effect before its first response in source order; confirm acknowledgement and authorization paths.", "tentative", "python_ast"))
            except SyntaxError as error:
                findings.append(Finding("error", "python_syntax", rel, error.lineno or 1, error.msg, "confirmed", "python_ast"))
        calls: list[tuple[int, str]] = []
        for kind, severity, rule, pattern, message in rules:
            if kind not in kinds:
                continue
            for match in pattern.finditer(text):
                confidence = "confirmed" if rule in {"secret_literal", "python_syntax"} else "tentative"
                _add(findings, rel, text, match, severity, rule, message, confidence)
                calls.append((match.start(), rule))
        calls.sort()
        for (left_pos, left), (_, right) in zip(calls, calls[1:]):
            if left != right and len(edges["impact"]) < 500:
                edges["impact"].append({"path": rel, "from": left, "to": right, "basis": "lexical_order"})
        if "interaction" in kinds:
            response_names = [rule for _, rule in calls if rule == "response_call"]
            if len(response_names) > 1:
                findings.append(Finding("warning", "multiple_response_paths", rel, 1, "Multiple response calls exist; inspect control flow for double acknowledgement.", "tentative"))
    findings.sort(key=lambda item: ({"error": 0, "warning": 1, "info": 2}.get(item.severity, 3), item.path, item.line, item.rule))
    return {"scanned_files": scanned, "analysis_mode": {"python": "ast_symbols_calls_plus_structural", "javascript_typescript": "structural; use analyze_typescript.mjs for compiler Program/type-checker evidence"}, "symbols": symbols, "findings": [asdict(item) for item in findings], "graphs": edges, "limitations": ["Python call targets are syntactic and do not resolve dynamic dispatch or full data flow.", "JavaScript/TypeScript structural findings require the compiler analyzer for stronger symbol evidence."]}
