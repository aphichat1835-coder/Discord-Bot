#!/usr/bin/env python3
"""Validate the bundled JSONL Discord engineering benchmark manifest."""

from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path
import sys
from typing import Any


REQUIRED = {"id", "profile", "risk", "task", "must_do", "must_not"}
RISKS = {"low", "medium", "high", "critical"}


def validate(path: Path) -> tuple[list[dict[str, Any]], list[str]]:
    cases: list[dict[str, Any]] = []
    errors: list[str] = []
    seen: set[str] = set()
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        return [], [str(error)]

    for number, raw in enumerate(lines, start=1):
        if not raw.strip():
            continue
        try:
            case = json.loads(raw)
        except json.JSONDecodeError as error:
            errors.append(f"line {number}: invalid JSON: {error.msg}")
            continue
        if not isinstance(case, dict):
            errors.append(f"line {number}: case must be an object")
            continue
        missing = sorted(REQUIRED - set(case))
        extra = sorted(set(case) - REQUIRED)
        if missing:
            errors.append(f"line {number}: missing fields: {missing}")
        if extra:
            errors.append(f"line {number}: unknown fields: {extra}")
        case_id = case.get("id")
        if not isinstance(case_id, str) or not case_id.strip():
            errors.append(f"line {number}: id must be a non-empty string")
        elif case_id in seen:
            errors.append(f"line {number}: duplicate id: {case_id}")
        else:
            seen.add(case_id)
        if case.get("risk") not in RISKS:
            errors.append(f"line {number}: risk must be one of {sorted(RISKS)}")
        for field in ("profile", "task"):
            if not isinstance(case.get(field), str) or not case[field].strip():
                errors.append(f"line {number}: {field} must be a non-empty string")
        for field in ("must_do", "must_not"):
            value = case.get(field)
            if not isinstance(value, list) or not value or not all(isinstance(item, str) and item.strip() for item in value):
                errors.append(f"line {number}: {field} must be a non-empty string array")
        cases.append(case)
    if len(cases) < 12:
        errors.append("benchmark manifest must contain at least 12 cases")
    return cases, errors


def main() -> int:
    default = Path(__file__).resolve().parents[1] / "assets" / "evals" / "discord-bot-engineer-benchmarks.jsonl"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", nargs="?", type=Path, default=default)
    parser.add_argument("--json", action="store_true", dest="json_output")
    args = parser.parse_args()
    cases, errors = validate(args.manifest)
    profiles = Counter(str(case.get("profile")) for case in cases)
    risks = Counter(str(case.get("risk")) for case in cases)
    result = {"cases": len(cases), "profiles": dict(sorted(profiles.items())), "risks": dict(sorted(risks.items())), "errors": errors}
    if args.json_output:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        for error in errors:
            print(f"error: {error}")
        print(f"benchmark manifest: cases={len(cases)} profiles={len(profiles)} errors={len(errors)}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
