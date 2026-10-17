from __future__ import annotations

from typing import Any

from .manifest import SKILL_ROOT, manifest, route_request


LEVEL_ORDER = ["micro", "standard", "deep", "incident"]


def _raise_level(current: str, minimum: str) -> str:
    return LEVEL_ORDER[max(LEVEL_ORDER.index(current), LEVEL_ORDER.index(minimum))]


def _estimated_tokens(paths: list[str]) -> dict[str, Any]:
    bytes_total = 0
    found = []
    for name in paths:
        path = SKILL_ROOT / "references" / name
        if path.is_file():
            size = path.stat().st_size
            bytes_total += size
            found.append({"name": name, "bytes": size, "estimated_tokens": max(1, round(size / 4))})
    control_bytes = (SKILL_ROOT / "SKILL.md").stat().st_size
    control_tokens = max(1, round(control_bytes / 4))
    reference_tokens = max(1, round(bytes_total / 4)) if bytes_total else 0
    return {"control_plane_bytes": control_bytes, "control_plane_estimated_tokens": control_tokens, "reference_bytes": bytes_total, "reference_estimated_tokens": reference_tokens, "total_estimated_tokens": control_tokens + reference_tokens, "method": "bytes_divided_by_four_approximation_not_model_billing", "items": found}


def make_token_budget(request: str, stack: dict[str, Any] | None = None) -> dict[str, Any]:
    routed = route_request(request, stack)
    config = manifest("token-budgets.json")
    level = config["risk_floor"][routed["risk"]]
    profiles = set(routed["profiles"])
    lowered = request.lower()
    micro_markers = ("typo", "spelling", "wording", "copy only", "คำสะกด", "แก้ข้อความ", "เปลี่ยนข้อความ")
    if any(marker in lowered for marker in micro_markers) and profiles <= {"interactions", "discordjs", "discordpy", "experience"}:
        level = "micro"
    if profiles & set(config["forced_deep_profiles"]):
        level = _raise_level(level, "deep")
    if profiles & set(config["forced_incident_profiles"]):
        level = "incident"
    settings = config["levels"][level]
    references = routed["references"]
    limit = settings["initial_reference_limit"]
    initial = references[:limit]
    deferred = references[limit:]
    return {
        "version": 1,
        "level": level,
        "risk": routed["risk"],
        "routes": routed["routes"],
        "profiles": routed["profiles"],
        "workflows": routed["workflows"],
        "references": {"initial": initial, "deferred_until_evidence_requires": deferred, "initial_limit": limit, "never_load_all_by_default": True},
        "tool_sequence": config["tool_order"][: settings["tool_depth"]],
        "output_policy": {"default": "compact", "finding_limit": settings["finding_limit"], "output_tail_chars": settings["output_tail_chars"], "full_artifact": "write_to_file_when_needed"},
        "protected_context": config["protected_context"],
        "escalation": {"automatic": True, "triggers": config["escalation_triggers"], "rule": "Raise the level or load a deferred reference when a trigger is evidenced; never suppress a required check to stay within budget."},
        "estimated_initial_context": _estimated_tokens(initial),
        "claim": "context_allocation_plan_not_an_execution_limit",
    }


def evaluate_budget_cases(document: dict[str, Any]) -> dict[str, Any]:
    results = []
    for case in document.get("cases", []):
        actual = make_token_budget(case["request"])
        missing = sorted(set(case.get("required_profiles", [])) - set(actual["profiles"]))
        checks = {
            "level": actual["level"] == case["expect_level"],
            "profiles": not missing,
            "reference_limit": len(actual["references"]["initial"]) <= case.get("max_initial_references", 999),
            "protected_context": bool(actual["protected_context"]),
            "automatic_escalation": actual["escalation"]["automatic"],
        }
        results.append({"id": case["id"], "passed": all(checks.values()), "checks": checks, "actual_level": actual["level"], "missing_profiles": missing})
    return {"passed": all(item["passed"] for item in results), "results": results}


def evaluate_skill_efficiency(document: dict[str, Any], skill_text: str) -> dict[str, Any]:
    words = len(skill_text.split())
    byte_count = len(skill_text.encode("utf-8"))
    missing = [anchor for anchor in document.get("required_anchors", []) if anchor not in skill_text]
    limits = document.get("limits", {})
    baseline = document.get("baseline", {})
    checks = {"word_limit": words <= limits.get("skill_words", words), "byte_limit": byte_count <= limits.get("skill_bytes", byte_count), "capability_anchors": not missing, "smaller_than_baseline": words < baseline.get("skill_words", words + 1) and byte_count < baseline.get("skill_bytes", byte_count + 1)}
    return {"passed": all(checks.values()), "checks": checks, "metrics": {"skill_words": words, "skill_bytes": byte_count, "baseline_words": baseline.get("skill_words"), "baseline_bytes": baseline.get("skill_bytes"), "word_reduction_percent": round((1 - words / baseline["skill_words"]) * 100, 1) if baseline.get("skill_words") else None, "byte_reduction_percent": round((1 - byte_count / baseline["skill_bytes"]) * 100, 1) if baseline.get("skill_bytes") else None}, "missing_anchors": missing}
