from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


LIFECYCLES = {
    "patch": ["requirements", "implementation", "verification", "completion"],
    "feature": ["planning", "requirements", "design", "implementation", "verification", "uat", "release", "maintenance"],
    "migration": ["discovery", "requirements", "design", "implementation", "compatibility", "verification", "rollout", "rollback", "maintenance"],
    "incident": ["detect", "contain", "reproduce", "diagnose", "recover", "verify", "monitor", "prevent_recurrence"],
    "retirement": ["inventory", "dependency_review", "deprecation", "data_disposition", "removal", "verification", "monitoring"],
}


def classify_lifecycle(request: str, risk: str = "medium") -> str:
    text = request.lower()
    if any(term in text for term in ("incident", "outage", "production down", "security breach", "ระบบล่ม", "ข้อมูลหาย")):
        return "incident"
    if any(term in text for term in ("retire", "decommission", "remove system", "เลิกใช้", "ยุติระบบ", "ถอดระบบ")):
        return "retirement"
    if any(term in text for term in ("migrate", "migration", "rewrite", "upgrade framework", "ย้ายระบบ", "เขียนใหม่", "เปลี่ยนเฟรมเวิร์ก")):
        return "migration"
    if any(term in text for term in ("bug", "fix", "error", "exception", "บัค", "แก้", "พัง")):
        return "patch"
    return "feature"


def make_sdlc_plan(request: str, contract: dict[str, Any] | None = None) -> dict[str, Any]:
    risk = str((contract or {}).get("risk", "medium"))
    lifecycle = classify_lifecycle(request, risk)
    phases = list(LIFECYCLES[lifecycle])
    if lifecycle == "patch" and risk in {"high", "critical"}:
        phases = ["requirements", "design", "implementation", "verification", "uat", "completion"]
    gates = {
        "requirements": ["goal", "scope", "constraints", "success_criteria", "unknowns"],
        "design": ["alternatives", "invariants", "data_and_side_effects", "rollback"],
        "verification": ["focused", "regression", "failure_paths", "security", "diff_review"],
        "uat": ["user_flow", "copy_and_ux", "acceptance_criteria"],
        "release": ["exact_revision", "environment", "migration", "rollback", "monitoring"],
    }
    required_gates = {phase: gates[phase] for phase in phases if phase in gates}
    if risk in {"high", "critical"}:
        required_gates.setdefault("design", gates["design"])
        required_gates.setdefault("uat", gates["uat"])
    return {
        "version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "request": request,
        "lifecycle": lifecycle,
        "risk": risk,
        "phases": phases,
        "required_gates": required_gates,
        "traceability": [
            {"requirement_id": "REQ-1", "requirement": (contract or {}).get("intent", {}).get("goal", request), "design": [], "changes": [], "tests": [], "evidence": [], "status": "unmapped"}
        ],
        "change_control": {"baseline": "request_and_current_project_evidence", "changes": [], "approval_required_for": ["scope", "destructive_behavior", "production", "billing", "architecture"]},
        "environment_lifecycle": ["local", "test", "preview_or_staging", "production"],
        "claim_policy": "phase evidence is required; unavailable live checks remain explicit unknowns",
    }


def sdlc_gate(plan: dict[str, Any], evidence: dict[str, Any]) -> dict[str, Any]:
    phase_evidence = evidence.get("phases", {})
    checks: dict[str, bool] = {}
    for phase in plan.get("phases", []):
        checks[phase] = bool(phase_evidence.get(phase, {}).get("passed"))
    traceability = plan.get("traceability", [])
    checks["traceability"] = bool(traceability) and all(item.get("status") in {"verified", "accepted", "not_applicable"} for item in evidence.get("traceability", traceability))
    unknowns = evidence.get("unknowns", [])
    passed = all(checks.values()) and not unknowns and not evidence.get("blockers")
    return {"passed": passed, "checks": checks, "unknowns": unknowns, "blockers": evidence.get("blockers", []), "claim": "complete" if passed else "not_verified_complete"}
