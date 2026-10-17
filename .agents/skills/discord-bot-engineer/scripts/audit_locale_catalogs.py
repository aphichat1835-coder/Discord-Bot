#!/usr/bin/env python3
"""Audit JSON locale catalogs for key, placeholder, and copy-integrity drift."""

from __future__ import annotations

import argparse
from collections import Counter
import json
import re
import sys
from pathlib import Path
from typing import Any

PLACEHOLDER_PATTERNS = (
    ("double_brace", re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")),
    ("brace", re.compile(r"(?<![{$])\{([A-Za-z_][A-Za-z0-9_]*)\}(?!\})")),
    ("percent", re.compile(r"%\(([A-Za-z_][A-Za-z0-9_]*)\)([a-zA-Z])")),
    ("dollar_brace", re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")),
)


def flatten(value: Any, prefix: str = "") -> tuple[dict[str, str], list[str]]:
    strings: dict[str, str] = {}
    errors: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            child_strings, child_errors = flatten(child, path)
            strings.update(child_strings)
            errors.extend(child_errors)
    elif isinstance(value, str):
        strings[prefix] = value
    else:
        errors.append(f"{prefix or '$'} must be a string or object, got {type(value).__name__}")
    return strings, errors


def placeholders(text: str) -> Counter[str]:
    found: Counter[str] = Counter()
    for style, pattern in PLACEHOLDER_PATTERNS:
        for match in pattern.findall(text):
            if isinstance(match, tuple):
                name, conversion = match
                token = f"{style}:{name}:{conversion}"
            else:
                token = f"{style}:{match}"
            found[token] += 1
    return found


def load_catalog(path: Path) -> tuple[dict[str, str], list[str]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return {}, [str(error)]
    if not isinstance(data, dict):
        return {}, ["catalog root must be an object"]
    return flatten(data)


def audit(base_path: Path, target_path: Path) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    base, base_errors = load_catalog(base_path)
    target, target_errors = load_catalog(target_path)
    errors.extend(f"{base_path}: {message}" for message in base_errors)
    errors.extend(f"{target_path}: {message}" for message in target_errors)
    if base_errors or target_errors:
        return errors, warnings

    missing = sorted(set(base) - set(target))
    extra = sorted(set(target) - set(base))
    errors.extend(f"{target_path}:{key}: missing key" for key in missing)
    warnings.extend(f"{target_path}:{key}: extra key" for key in extra)

    for key in sorted(set(base) & set(target)):
        source = base[key]
        translated = target[key]
        location = f"{target_path}:{key}"

        if not translated.strip():
            errors.append(f"{location}: empty translation")
            continue
        if translated != translated.strip():
            warnings.append(f"{location}: leading or trailing whitespace")
        if "..." in translated:
            warnings.append(f"{location}: use the single ellipsis character (…) when appropriate")
        source_placeholders = placeholders(source)
        target_placeholders = placeholders(translated)
        if source_placeholders != target_placeholders:
            errors.append(
                f"{location}: placeholder mismatch "
                f"source={sorted(source_placeholders.elements())} "
                f"target={sorted(target_placeholders.elements())}"
            )
        if source.count("\n") != translated.count("\n"):
            warnings.append(f"{location}: newline count differs from source")
        if source == translated and re.search(r"[A-Za-zÀ-ÿก-๙]", source):
            warnings.append(f"{location}: translation is identical to source; verify intentionally shared copy")
        for marker in ("```", "**", "__", "~~"):
            if translated.count(marker) % 2:
                warnings.append(f"{location}: unbalanced Markdown marker {marker!r}")

    return errors, warnings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base", type=Path, help="source JSON catalog")
    parser.add_argument("targets", nargs="+", type=Path, help="translated JSON catalogs")
    parser.add_argument("--strict", action="store_true", help="treat warnings as failures")
    args = parser.parse_args()

    all_errors: list[str] = []
    all_warnings: list[str] = []
    for target in args.targets:
        errors, warnings = audit(args.base, target)
        all_errors.extend(errors)
        all_warnings.extend(warnings)

    for message in all_errors:
        print(f"error: {message}")
    for message in all_warnings:
        print(f"warning: {message}")
    if not all_errors and not all_warnings:
        print("locale catalogs: PASS")

    return 1 if all_errors or (args.strict and all_warnings) else 0


if __name__ == "__main__":
    raise SystemExit(main())
