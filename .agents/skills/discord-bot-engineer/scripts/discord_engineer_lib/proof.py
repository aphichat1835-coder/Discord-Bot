from __future__ import annotations

from typing import Any

from .manifest import manifest


def production_proof_gate(evidence: dict[str, Any], target: str = "repository_verified") -> dict[str, Any]:
    if "evidence" in evidence:
        target = evidence.get("target", target)
        envelope = evidence
        evidence = {
            **evidence["evidence"],
            "unknowns": evidence["evidence"].get("unknowns", envelope.get("unknowns", [])),
            "blockers": evidence["evidence"].get("blockers", envelope.get("blockers", [])),
        }
    configured_levels = manifest("production-proof.json").get("levels", {})
    levels = [name for name in ("deterministic_verified", "repository_verified", "experience_verified", "live_verified") if name in configured_levels]
    if target not in levels:
        raise ValueError(f"unsupported proof target: {target}")
    checks = {}
    for level in levels[:levels.index(target) + 1]:
        group = level.removesuffix("_verified")
        supplied = evidence.get(group, {})
        requirements = [item for item in configured_levels[level].get("requires", []) if item not in configured_levels]
        checks[group] = {item: bool(supplied.get(item, {}).get("passed") if isinstance(supplied.get(item), dict) else supplied.get(item)) for item in requirements}
    unknowns = evidence.get("unknowns", [])
    blockers = evidence.get("blockers", [])
    passed = all(all(group.values()) for group in checks.values()) and not unknowns and not blockers
    return {"passed": passed, "target": target, "claim": target if passed else "proof_incomplete", "checks": checks, "unknowns": unknowns, "blockers": blockers, "rule": "A lower proof level must never be described as live or production verification."}
