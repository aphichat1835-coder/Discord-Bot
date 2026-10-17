from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .io_utils import SOURCE_SUFFIXES, read_text, relative, walk_files


BASE_COUNTEREXAMPLES = ["reported_reproduction", "normal_success", "empty_or_missing_state", "permission_denied", "partial_failure", "retry_after_failure"]
RISK_COUNTEREXAMPLES = {
    "high": ["duplicate_request", "concurrent_change", "timeout", "restart_recovery", "stale_state"],
    "critical": ["forged_input", "rollback", "cross_tenant_isolation", "external_dependency_failure", "audit_reconciliation"],
}


def make_defect_contract(request: str, risk: str = "medium") -> dict[str, Any]:
    cases = list(BASE_COUNTEREXAMPLES)
    if risk in {"high", "critical"}:
        cases.extend(RISK_COUNTEREXAMPLES["high"])
    if risk == "critical":
        cases.extend(RISK_COUNTEREXAMPLES["critical"])
    return {
        "version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "request": request,
        "risk": risk,
        "reproduction": {"steps": [], "expected": None, "actual": None, "environment": [], "frequency": None, "status": "unconfirmed"},
        "root_cause": {"symptom": request, "earliest_violated_invariant": None, "causal_path": [], "confidence": "unknown", "why_existing_tests_missed": None},
        "neighborhood": {"symbols": [], "shared_callers": [], "duplicate_logic": [], "state_stores": [], "external_boundaries": []},
        "counterexamples": [{"id": item, "required": True, "evidence": None, "status": "pending"} for item in cases],
        "regression": {"fails_before_fix": None, "passes_after_fix": None, "test_locations": []},
        "live_boundary": {"level": "not_run", "environment": None, "evidence": []},
        "status": "open",
    }


def scan_neighborhood(root: Path, symbols: list[str], max_files: int = 4000) -> dict[str, Any]:
    clean = [symbol for symbol in symbols if symbol and len(symbol) >= 2]
    hits: list[dict[str, Any]] = []
    for path in walk_files(root, suffixes=SOURCE_SUFFIXES, max_files=max_files):
        text = read_text(path)
        if text is None:
            continue
        for symbol in clean:
            matches = list(re.finditer(rf"(?<![A-Za-z0-9_$]){re.escape(symbol)}(?![A-Za-z0-9_$])", text))
            if matches:
                hits.append({"symbol": symbol, "path": relative(root, path), "lines": [text.count("\n", 0, match.start()) + 1 for match in matches[:20]], "occurrences": len(matches), "basis": "lexical_symbol_reference"})
    by_symbol = {symbol: [hit for hit in hits if hit["symbol"] == symbol] for symbol in clean}
    return {"version": 1, "root": str(root.resolve()), "symbols": clean, "hits": hits, "by_symbol": by_symbol, "limitations": ["Lexical neighborhood is a search boundary, not a proven call or data-flow graph."]}


def defect_gate(contract: dict[str, Any], evidence: dict[str, Any]) -> dict[str, Any]:
    reproduction = evidence.get("reproduction", contract.get("reproduction", {}))
    root_cause = evidence.get("root_cause", contract.get("root_cause", {}))
    regression = evidence.get("regression", contract.get("regression", {}))
    counterexamples = evidence.get("counterexamples", contract.get("counterexamples", []))
    checks = {
        "reproduction_accounted_for": reproduction.get("status") in {"confirmed", "blocked_with_reason"},
        "root_cause_supported": root_cause.get("confidence") in {"confirmed", "strong_inference"} and bool(root_cause.get("causal_path")),
        "neighborhood_reviewed": bool(evidence.get("neighborhood_reviewed")),
        "regression_proof": regression.get("fails_before_fix") is True and regression.get("passes_after_fix") is True,
        "counterexamples": bool(counterexamples) and all(item.get("status") in {"passed", "not_applicable"} for item in counterexamples),
        "diff_review": bool(evidence.get("diff_review")),
        "security_review": bool(evidence.get("security_review")),
    }
    passed = all(checks.values()) and not evidence.get("unknowns") and not evidence.get("blockers")
    live_level = evidence.get("live_boundary", contract.get("live_boundary", {})).get("level", "not_run")
    claim = "verified_in_live_environment" if passed and live_level in {"test_guild", "staging", "production_observed"} else ("implemented_and_regression_verified" if passed else "not_verified_complete")
    return {"passed": passed, "checks": checks, "claim": claim, "live_level": live_level, "unknowns": evidence.get("unknowns", []), "blockers": evidence.get("blockers", [])}
