from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .manifest import manifest, route_request


def make_feature_contract(request: str, root: Path | None = None, stack: dict[str, Any] | None = None) -> dict[str, Any]:
    routed = route_request(request, stack)
    profiles = manifest("profiles.json")["profiles"]
    selected = [profiles[name] | {"id": name} for name in routed["profiles"]]
    risk_order = {"low": 0, "medium": 1, "high": 2, "critical": 3}
    risk = max((item.get("risk", "medium") for item in selected), key=lambda x: risk_order[x], default="medium")
    request_lower = request.lower()
    destructive = any(term in request_lower for term in ("delete", "purge", "ban", "kick", "remove", "ลบ", "แบน", "เตะ", "ถอด"))
    external = any(term in request_lower for term in ("deploy", "release", "merge", "production", "ดีพลอย", "รีลีส", "เมิร์จ", "โปรดักชัน"))
    intent = {
        "goal": request.strip(),
        "scope": ["Resolve against current project evidence before editing."],
        "constraints": (["Destructive effects require explicit target and authority boundaries."] if destructive else []) + (["External publication or production mutation requires matching authority."] if external else []),
        "success_criteria": ["The requested observable behavior is implemented.", "Relevant regression and failure-path evidence passes.", "Remaining live or external boundaries are declared."],
        "prohibitions": ["Do not broaden scope, discard user work, fabricate evidence, or weaken checks to obtain a pass."],
    }
    requirements = [{"id": "REQ-1", "statement": request.strip(), "source": "user_request", "status": "needs_project_trace"}]
    return {
        "version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "request": request,
        "project_root": str(root.resolve()) if root else None,
        "intent": intent,
        "requirements": requirements,
        "route": routed,
        "risk": risk,
        "invariants": sorted({x for item in selected for x in item.get("invariants", [])}),
        "verification": sorted({x for item in selected for x in item.get("tests", [])}),
        "unknowns": ["Confirm project-specific behavior, affected paths, and live/external boundaries from primary evidence."],
        "status": "draft_requires_project_evidence",
    }


def completion_gate(contract: dict[str, Any], receipt: dict[str, Any]) -> dict[str, Any]:
    def passed(value: Any) -> bool:
        return bool(value.get("passed")) if isinstance(value, dict) else value is True

    checks = {
        "requirements": bool(contract.get("intent", {}).get("goal") and contract.get("intent", {}).get("success_criteria")),
        "diff_review": passed(receipt.get("checks", {}).get("diff_review")),
        "tests": passed(receipt.get("checks", {}).get("tests")),
        "security": passed(receipt.get("checks", {}).get("security")),
        "traceability": passed(receipt.get("checks", {}).get("traceability")),
        "no_material_unknowns": "unknowns" in receipt and not receipt.get("unknowns"),
        "no_blockers": "blockers" not in receipt or not receipt.get("blockers"),
        "receipt_not_failed": receipt.get("passed") is not False,
    }
    profiles = set(contract.get("route", {}).get("profiles", []))
    if "defect" in profiles:
        checks["defect_closure"] = passed(receipt.get("checks", {}).get("defect_closure"))
    if "experience" in profiles:
        checks["experience_review"] = passed(receipt.get("checks", {}).get("experience_review"))
    if profiles & {"interactions", "moderation", "verification", "tickets", "economy", "music", "dashboard", "monetization", "distributed"}:
        checks["domain_review"] = passed(receipt.get("checks", {}).get("domain_review"))
    if "sdlc" in contract.get("route", {}).get("workflows", {}).get("activated", []):
        checks["sdlc"] = passed(receipt.get("checks", {}).get("sdlc"))
    return {"passed": all(checks.values()), "checks": checks, "claim": "complete" if all(checks.values()) else "not_verified_complete"}
