from __future__ import annotations

from pathlib import Path
from typing import Any

from .project_model import build_project_model


SCRIPT_ORDER = ["format:check", "lint", "typecheck", "test", "test:unit", "test:integration", "build"]


def _node_command(manager: str, script: str) -> list[str]:
    if manager == "npm":
        return ["npm", "run", script] if script != "test" else ["npm", "test"]
    return [manager, "run", script]


def make_verification_plan(root: Path, risk: str = "medium", profiles: list[str] | None = None) -> dict[str, Any]:
    model = build_project_model(root)
    manager = model["toolchain"].get("package_manager")
    node_manager = model["toolchain"].get("node_package_manager") or manager
    python_manager = model["toolchain"].get("python_package_manager")
    scripts = set(model["toolchain"].get("scripts", []))
    checks: list[dict[str, Any]] = []
    for script in SCRIPT_ORDER:
        if node_manager in {"npm", "pnpm", "yarn", "bun"} and script in scripts:
            required = script in {"lint", "typecheck", "test"}
            required = required or (script == "build" and risk in {"medium", "high", "critical"})
            required = required or (script == "test:integration" and risk in {"high", "critical"})
            checks.append({"id": script.replace(":", "_"), "kind": script.split(":")[0], "command": _node_command(node_manager, script), "required": required, "source": "repository_script", "timeout_seconds": 180})
    if model["toolchain"].get("python"):
        python_command = ["uv", "run", "pytest", "-q"] if python_manager == "uv" else (["poetry", "run", "pytest", "-q"] if python_manager == "poetry" else ["python3", "-m", "pytest", "-q"])
        checks.append({"id": "pytest", "kind": "test", "command": python_command, "required": True, "source": "python_project", "timeout_seconds": 180})
    profile_set = set(profiles or [])
    scenario_checks: list[str] = []
    if profile_set & {"moderation", "verification", "economy", "music", "dashboard", "distributed"} or risk in {"high", "critical"}:
        scenario_checks.extend(["denial", "duplicate", "partial_failure", "timeout", "restart_recovery"])
    if profile_set & {"economy", "distributed", "tickets"}:
        scenario_checks.extend(["concurrency", "idempotency", "rollback"])
    if profile_set & {"experience", "dashboard"}:
        scenario_checks.extend(["state_matrix", "mobile_or_narrow_layout", "accessibility", "visual_review"])
    return {
        "version": 1,
        "root": str(root.resolve()),
        "risk": risk,
        "profiles": sorted(profile_set),
        "commands": checks,
        "scenario_checks": sorted(set(scenario_checks)),
        "manual_or_live": ["Discord Developer Portal intents/scopes", "test-guild interaction", "production-only integrations"] + (["Workspace-wide affected-package selection and shared-package regression scope"] if model["toolchain"].get("workspace_roots") else []),
        "selection_basis": {"package_manager": manager, "package_managers": model["toolchain"].get("package_managers", []), "scripts": sorted(scripts), "project_signals": sorted(model.get("signals", {}).keys())},
    }
