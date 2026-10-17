#!/usr/bin/env python3
"""Validate a framework-neutral Discord experience snapshot JSON file."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ALLOWED_STATES = {
    "received",
    "acknowledged",
    "confirming",
    "queued",
    "running",
    "waiting",
    "empty",
    "permission_denied",
    "partial",
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "idle",
    "working",
    "validating",
    "recovering",
    "recoverable_error",
    "terminal_error",
    "dirty",
    "saving",
}
ALLOWED_SURFACES = {
    "plain",
    "embed",
    "components_v2",
    "modal",
    "ephemeral",
    "dm",
    "dashboard",
}
TERMINAL_STATES = {"empty", "permission_denied", "partial", "succeeded", "failed", "cancelled", "timed_out"}


def issue(level: str, path: str, message: str) -> dict[str, str]:
    return {"level": level, "path": path, "message": message}


def validate_snapshot(data: Any) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    if not isinstance(data, dict):
        return [issue("error", "$", "snapshot root must be an object")]

    command = data.get("command")
    if not isinstance(command, str) or not command.strip():
        findings.append(issue("error", "$.command", "command must be a non-empty string"))

    locale = data.get("locale")
    if not isinstance(locale, str) or not locale.strip():
        findings.append(issue("error", "$.locale", "locale must be a non-empty string"))

    required_states = data.get("required_states", [])
    if not isinstance(required_states, list) or not all(isinstance(item, str) for item in required_states):
        findings.append(issue("error", "$.required_states", "required_states must be an array of strings"))
        required_states = []

    states = data.get("states")
    if not isinstance(states, list) or not states:
        findings.append(issue("error", "$.states", "states must be a non-empty array"))
        return findings

    seen_names: set[str] = set()
    for index, state in enumerate(states):
        base = f"$.states[{index}]"
        if not isinstance(state, dict):
            findings.append(issue("error", base, "state must be an object"))
            continue

        name = state.get("name")
        if not isinstance(name, str) or not name:
            findings.append(issue("error", f"{base}.name", "state name must be a non-empty string"))
            continue
        if name not in ALLOWED_STATES:
            findings.append(issue("warning", f"{base}.name", f"unknown lifecycle state: {name}"))
        if name in seen_names:
            findings.append(issue("error", f"{base}.name", f"duplicate state: {name}"))
        seen_names.add(name)

        surface = state.get("surface")
        if surface not in ALLOWED_SURFACES:
            findings.append(issue("error", f"{base}.surface", f"surface must be one of {sorted(ALLOWED_SURFACES)}"))

        copy = state.get("copy")
        if not isinstance(copy, dict) or not copy:
            findings.append(issue("error", f"{base}.copy", "copy must be a non-empty object"))
        elif not any(isinstance(value, str) and value.strip() for value in copy.values()):
            findings.append(issue("error", f"{base}.copy", "copy must contain at least one non-empty string"))

        progress = state.get("progress")
        if progress is not None:
            findings.extend(validate_progress(progress, f"{base}.progress", name))

        controls = state.get("controls", [])
        if not isinstance(controls, list):
            findings.append(issue("error", f"{base}.controls", "controls must be an array"))
            continue

        control_ids: set[str] = set()
        for control_index, control in enumerate(controls):
            control_path = f"{base}.controls[{control_index}]"
            if not isinstance(control, dict):
                findings.append(issue("error", control_path, "control must be an object"))
                continue
            custom_id = control.get("id")
            if custom_id is not None:
                if not isinstance(custom_id, str) or not custom_id:
                    findings.append(issue("error", f"{control_path}.id", "control id must be a non-empty string"))
                elif custom_id in control_ids:
                    findings.append(issue("error", f"{control_path}.id", f"duplicate control id: {custom_id}"))
                else:
                    control_ids.add(custom_id)

            disabled = control.get("disabled")
            if disabled is not None and not isinstance(disabled, bool):
                findings.append(issue("error", f"{control_path}.disabled", "disabled must be a boolean"))
            if name in TERMINAL_STATES and control.get("action") == "cancel" and disabled is not True:
                findings.append(issue("error", control_path, "cancel control must be disabled in a terminal state"))

    for required in required_states:
        if required not in seen_names:
            findings.append(issue("error", "$.required_states", f"required state is missing: {required}"))

    return findings


def validate_progress(progress: Any, path: str, state_name: str) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    if not isinstance(progress, dict):
        return [issue("error", path, "progress must be an object")]

    mode = progress.get("mode")
    if mode not in {"indeterminate", "determinate", "waiting", "none"}:
        findings.append(issue("error", f"{path}.mode", "invalid progress mode"))
        return findings

    if mode == "determinate":
        completed = progress.get("completed")
        total = progress.get("total")
        if not isinstance(completed, (int, float)) or isinstance(completed, bool) or completed < 0:
            findings.append(issue("error", f"{path}.completed", "completed must be a non-negative number"))
        if not isinstance(total, (int, float)) or isinstance(total, bool) or total <= 0:
            findings.append(issue("error", f"{path}.total", "total must be greater than zero"))
        if isinstance(completed, (int, float)) and isinstance(total, (int, float)) and completed > total:
            findings.append(issue("error", path, "completed cannot exceed total"))

    if state_name in TERMINAL_STATES and mode in {"indeterminate", "waiting"}:
        findings.append(issue("warning", path, "terminal state still appears to be in progress"))
    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("--strict", action="store_true", help="treat warnings as failures")
    parser.add_argument("--json", action="store_true", dest="json_output")
    args = parser.parse_args()

    try:
        data = json.loads(args.snapshot.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    findings = validate_snapshot(data)
    if args.json_output:
        print(json.dumps({"findings": findings}, ensure_ascii=False, indent=2))
    else:
        for finding in findings:
            print(f"{finding['level']}: {finding['path']}: {finding['message']}")
        if not findings:
            print("experience snapshot: PASS")

    errors = any(item["level"] == "error" for item in findings)
    warnings = any(item["level"] == "warning" for item in findings)
    return 1 if errors or (args.strict and warnings) else 0


if __name__ == "__main__":
    raise SystemExit(main())
