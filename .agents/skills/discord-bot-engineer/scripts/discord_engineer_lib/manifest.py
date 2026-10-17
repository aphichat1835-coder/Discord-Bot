from __future__ import annotations

from pathlib import Path
import re
from typing import Any

from .io_utils import load_json

SKILL_ROOT = Path(__file__).resolve().parents[2]
MANIFEST_ROOT = SKILL_ROOT / "assets" / "manifests"
SCHEMA_ROOT = SKILL_ROOT / "assets" / "schemas"


def manifest(name: str) -> dict[str, Any]:
    value = load_json(MANIFEST_ROOT / name)
    if not isinstance(value, dict):
        raise ValueError(f"manifest must be an object: {name}")
    return value


def validate_manifests() -> list[str]:
    errors: list[str] = []
    files = sorted(MANIFEST_ROOT.glob("*.json"))
    for path in files:
        try:
            value = load_json(path)
        except Exception as error:
            errors.append(f"{path.name}: {error}")
            continue
        if not isinstance(value, dict) or value.get("version") != 1:
            errors.append(f"{path.name}: root must be object with version=1")

    routes = manifest("routes.json")
    profiles = manifest("profiles.json").get("profiles", {})
    security_profiles = manifest("security-profiles.json").get("profiles", {})
    copy_voice = manifest("copy-voice.json")
    references = SKILL_ROOT / "references"
    for route in routes.get("routes", []):
        for profile in route.get("profiles", []):
            if profile not in profiles:
                errors.append(f"route {route.get('id')}: unknown profile {profile}")
        for reference in route.get("references", []):
            if not (references / reference).is_file():
                errors.append(f"route {route.get('id')}: missing reference {reference}")
    for name, profile in profiles.items():
        reference = profile.get("reference")
        if reference and not (references / reference).is_file():
            errors.append(f"profile {name}: missing reference {reference}")
        security = profile.get("security")
        if security and security not in security_profiles:
            errors.append(f"profile {name}: unknown security profile {security}")

    copy_tiers = copy_voice.get("tiers", {})
    for tier in ("brief", "contextual", "operational"):
        if not isinstance(copy_tiers.get(tier), dict) or not copy_tiers[tier].get("rules"):
            errors.append(f"copy-voice.json: missing rules for {tier}")
    copy_placements = copy_voice.get("placements", {})
    for placement in ("label_or_button", "loading_or_status_headline", "panel_summary", "supporting_detail", "error_recovery", "destructive_confirmation", "diagnostics"):
        if not isinstance(copy_placements.get(placement), dict) or not copy_placements[placement].get("density"):
            errors.append(f"copy-voice.json: missing density for {placement}")

    panels = manifest("panel-archetypes.json").get("panels", {})
    recipes = manifest("components-v2-recipes.json").get("recipes", {})
    for name, pattern in manifest("command-experience-patterns.json").get("patterns", {}).items():
        if pattern.get("panel") not in panels:
            errors.append(f"command-experience-patterns.json: {name} has unknown panel {pattern.get('panel')}")
        if pattern.get("recipe") not in recipes:
            errors.append(f"command-experience-patterns.json: {name} has unknown recipe {pattern.get('recipe')}")
    palette = manifest("discord-component-palette.json")
    declared_types = {value for surface in ("message", "modal") for group in palette.get(surface, {}).values() for value in group.values()}
    if declared_types != {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 18, 19, 21, 22, 23}:
        errors.append("discord-component-palette.json: component type coverage is incomplete or unknown")

    github_gates = manifest("github-gates.json")
    known_gates = {"repository_resolved", "base_head_sha", "requirements", "diff_review", "tests", "security", "required_checks", "reviews_resolved", "mergeable", "unknowns_clear"}
    for gate in github_gates.get("ready_to_merge", []):
        if gate not in known_gates:
            errors.append(f"github-gates.json: unknown ready_to_merge gate {gate}")

    proof_levels = manifest("production-proof.json").get("levels", {})
    ordered_proof_levels = ["deterministic_verified", "repository_verified", "experience_verified", "live_verified"]
    for index, level in enumerate(ordered_proof_levels):
        config = proof_levels.get(level)
        if not isinstance(config, dict) or not isinstance(config.get("requires"), list) or not config["requires"]:
            errors.append(f"production-proof.json: {level} must declare non-empty requirements")
            continue
        dependencies = [item for item in config["requires"] if item.endswith("_verified")]
        if index and ordered_proof_levels[index - 1] not in dependencies:
            errors.append(f"production-proof.json: {level} must depend on {ordered_proof_levels[index - 1]}")

    for path in sorted(SCHEMA_ROOT.glob("*.json")):
        try:
            value = load_json(path)
        except Exception as error:
            errors.append(f"{path.name}: {error}")
            continue
        if not isinstance(value, dict) or "$schema" not in value or "type" not in value:
            errors.append(f"{path.name}: invalid schema header")
    return errors


def route_request(request: str, stack: dict[str, Any] | None = None) -> dict[str, Any]:
    config = manifest("routes.json")
    lowered = request.lower()
    matched: list[dict[str, Any]] = []
    for route in config.get("routes", []):
        def matches(term: str) -> bool:
            candidate = term.lower()
            if candidate.isascii() and candidate.replace("_", "").isalnum() and len(candidate) <= 3:
                return re.search(rf"(?<![a-z0-9_]){re.escape(candidate)}(?![a-z0-9_])", lowered) is not None
            return candidate in lowered

        score = sum(1 for term in route.get("terms", []) if matches(term))
        if score:
            matched.append({**route, "score": score})
    if stack:
        framework = str(stack.get("framework", "")).lower()
        for route in config.get("routes", []):
            if route["id"] in {"discordjs", "discordpy"} and route["id"].replace("discord", "discord.") in framework:
                matched.append({**route, "score": 10})
    by_id: dict[str, dict[str, Any]] = {}
    for item in matched:
        existing = by_id.get(item["id"])
        if existing is None or item["score"] > existing["score"]:
            by_id[item["id"]] = item
    ordered = sorted(by_id.values(), key=lambda item: (-item["score"], item["id"]))
    profiles = sorted({profile for item in ordered for profile in item.get("profiles", [])})
    analyzers = sorted({name for item in ordered for name in item.get("analyzers", [])})
    references = sorted({name for item in ordered for name in item.get("references", [])})
    workflow_config = manifest("workflows.json").get("workflows", [])
    activated: list[str] = []
    skipped: list[str] = []
    for workflow in workflow_config:
        selected = bool(workflow.get("always"))
        selected = selected or bool(set(workflow.get("profiles", [])) & set(profiles))
        prefix = workflow.get("profile_prefix")
        selected = selected or bool(prefix and any(profile.startswith(prefix) for profile in profiles))
        (activated if selected else skipped).append(workflow["id"])
    profile_config = manifest("profiles.json").get("profiles", {})
    risk_order = {"low": 0, "medium": 1, "high": 2, "critical": 3}
    risk = max((profile_config.get(name, {}).get("risk", "medium") for name in profiles), key=lambda item: risk_order[item], default="medium")
    depth = {"low": "fast", "medium": "standard", "high": "deep", "critical": "incident"}[risk]
    return {"routes": [item["id"] for item in ordered], "profiles": profiles, "analyzers": analyzers, "references": references, "risk": risk, "depth": depth, "workflows": {"activated": activated, "skipped_not_applicable": skipped, "blocked": []}}
