#!/usr/bin/env python3
"""Heuristically audit Discord project source for high-value review leads."""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
import json
import os
from pathlib import Path
import re
import sys
from typing import Iterable


IGNORED_DIRS = {
    ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "env", "dist",
    "build", "coverage", ".next", ".nuxt", ".cache", "__pycache__",
}
SOURCE_SUFFIXES = {".js", ".cjs", ".mjs", ".jsx", ".ts", ".tsx", ".py"}


@dataclass(frozen=True)
class Finding:
    level: str
    rule: str
    path: str
    line: int
    message: str


def walk_sources(root: Path, max_files: int) -> Iterable[Path]:
    yielded = 0
    for directory, directory_names, file_names in os.walk(root):
        directory_names[:] = [name for name in directory_names if name not in IGNORED_DIRS]
        current = Path(directory)
        for name in file_names:
            path = current / name
            if path.suffix.lower() not in SOURCE_SUFFIXES:
                continue
            if yielded >= max_files:
                return
            yielded += 1
            yield path


def read_text(path: Path) -> str | None:
    try:
        if path.stat().st_size > 750_000:
            return None
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def add(findings: list[Finding], level: str, rule: str, relative: str, line: int, message: str) -> None:
    findings.append(Finding(level, rule, relative, line, message))


def audit_file(root: Path, path: Path, text: str) -> list[Finding]:
    findings: list[Finding] = []
    relative = path.relative_to(root).as_posix()
    lines = text.splitlines()
    is_python = path.suffix.lower() == ".py"
    is_javascript = not is_python

    secret_literal = re.compile(
        r"(?i)\b(?:discord_?token|bot_?token|client_?secret|webhook_?url)\b\s*[:=]\s*"
        r"[rubfRUBF]*[\"'][^\"']{16,}[\"']"
    )
    secret_log = re.compile(
        r"(?i)(?:console\.(?:log|debug|info|warn|error)|logger\.[a-z]+|print)\s*\([^\n]*"
        r"(?:token|secret|webhook|process\.env|os\.environ|config)"
    )
    broad_swallow_js = re.compile(r"\.catch\s*\(\s*\(?(?:err|error|e)?\)?\s*=>\s*\{?\s*\}?\s*\)")
    bare_except = re.compile(r"^\s*except(?:\s+Exception)?\s*:\s*(?:pass\s*)?$")

    for number, line in enumerate(lines, start=1):
        if secret_literal.search(line):
            add(findings, "error", "secret-literal", relative, number, "possible Discord/OAuth/webhook secret literal; move it to protected configuration and rotate if real")
        if secret_log.search(line):
            add(findings, "error", "secret-logging", relative, number, "logging may expose credentials or full configuration; log an allowlisted safe projection")
        if is_python and re.search(r"\btime\.sleep\s*\(", line):
            add(findings, "warning", "blocking-sleep", relative, number, "time.sleep may block the Discord event loop; confirm execution context and prefer an async wait")
        if is_python and bare_except.match(line):
            add(findings, "warning", "swallowed-exception", relative, number, "broad/bare exception handling may hide task or interaction failure")
        if is_python and "asyncio.create_task(" in line:
            add(findings, "info", "untracked-task", relative, number, "confirm this task has an owner, observed exceptions, cancellation, and shutdown cleanup")
        if is_javascript and broad_swallow_js.search(line):
            add(findings, "warning", "swallowed-promise", relative, number, "empty promise rejection handler may hide Discord or persistence failure")
        if re.search(r"\bsetInterval\s*\(", line):
            add(findings, "info", "interval-lifecycle", relative, number, "confirm interval ownership, duplicate startup protection, shutdown cleanup, and error observation")
        if re.search(r"\bAdministrator\b", line) and re.search(r"permission|Permission", line):
            add(findings, "info", "administrator-permission", relative, number, "confirm Administrator is truly required instead of narrower bot permissions")
        if re.search(r"\bMessageContent\b|message_content\s*=\s*True", line):
            add(findings, "info", "privileged-intent", relative, number, "confirm Message Content intent is required and enabled in the Developer Portal")

    if is_python and re.search(r"\basync\s+def\b", text):
        for number, line in enumerate(lines, start=1):
            if re.search(r"\brequests\.(?:get|post|put|patch|delete|request)\s*\(", line):
                add(findings, "warning", "sync-http-in-async-project", relative, number, "synchronous requests call appears in async Discord code; confirm it cannot block the event loop")

    if is_javascript:
        collector = re.compile(r"createMessageComponentCollector\s*\(")
        for match in collector.finditer(text):
            snippet = text[match.start():match.start() + 800]
            statement_end = snippet.find(");")
            if statement_end >= 0:
                snippet = snippet[:statement_end + 2]
            if not re.search(r"\b(?:time|idle)\s*:", snippet):
                line = text.count("\n", 0, match.start()) + 1
                add(findings, "warning", "unbounded-collector", relative, line, "component collector has no visible time/idle bound; confirm external terminal cleanup")

    if is_python and re.search(r"class\s+\w+\s*\(\s*(?:discord\.ui\.)?View\s*\)", text):
        if re.search(r"timeout\s*=\s*None", text) and "custom_id" not in text:
            line = text.count("\n", 0, text.find("timeout")) + 1
            add(findings, "warning", "persistent-view-routing", relative, line, "persistent View appears to lack an explicit custom_id; confirm restart-safe routing")

    return findings


def audit(root: Path, max_files: int) -> tuple[list[Finding], int]:
    findings: list[Finding] = []
    scanned = 0
    for path in walk_sources(root, max_files):
        text = read_text(path)
        if text is None:
            continue
        scanned += 1
        findings.extend(audit_file(root, path, text))
    findings.sort(key=lambda item: ({"error": 0, "warning": 1, "info": 2}[item.level], item.path, item.line, item.rule))
    return findings, scanned


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project_root", nargs="?", default=".")
    parser.add_argument("--strict", action="store_true", help="treat warnings as failures")
    parser.add_argument("--json", action="store_true", dest="json_output")
    parser.add_argument("--max-files", type=int, default=4000)
    args = parser.parse_args()
    root = Path(args.project_root).expanduser().resolve()
    if not root.is_dir():
        parser.error(f"not a directory: {root}")
    if args.max_files < 1:
        parser.error("--max-files must be positive")

    findings, scanned = audit(root, args.max_files)
    if args.json_output:
        print(json.dumps({"scanned_files": scanned, "findings": [asdict(item) for item in findings]}, indent=2, ensure_ascii=False))
    else:
        for item in findings:
            print(f"{item.level}: {item.rule}: {item.path}:{item.line}: {item.message}")
        print(f"discord project audit: scanned={scanned} errors={sum(f.level == 'error' for f in findings)} warnings={sum(f.level == 'warning' for f in findings)} info={sum(f.level == 'info' for f in findings)}")

    has_errors = any(item.level == "error" for item in findings)
    has_warnings = any(item.level == "warning" for item in findings)
    return 1 if has_errors or (args.strict and has_warnings) else 0


if __name__ == "__main__":
    sys.exit(main())
