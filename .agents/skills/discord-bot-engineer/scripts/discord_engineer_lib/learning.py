from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any


SENSITIVE_KEY = re.compile(r"(?i)(token|secret|password|authorization|cookie|webhook|email|ip_address)")
SENSITIVE_TEXT_PATTERNS = (
    re.compile(r"(?i)\b(?:bearer\s+)[A-Za-z0-9._~+/=-]{12,}"),
    re.compile(r"\b(?:mfa\.)?[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\bgh[opusr]_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"(?i)https://(?:canary\.|ptb\.)?discord(?:app)?\.com/api/webhooks/\d+/[A-Za-z0-9._-]+"),
    re.compile(r"(?i)\b(token|secret|password|authorization|cookie|webhook(?:_url)?|api[_-]?key)(\s*[:=]\s*)([^\s,;]+)"),
    re.compile(r"(?i)\b(token|secret|password|authorization|cookie|webhook)(\s+)([A-Za-z0-9._~+/=-]{16,})"),
)


def redact_text(value: str) -> str:
    redacted = value
    for pattern in SENSITIVE_TEXT_PATTERNS:
        if pattern.groups >= 3:
            redacted = pattern.sub(r"\1\2[REDACTED]", redacted)
        else:
            redacted = pattern.sub("[REDACTED]", redacted)
    return redacted


def redact(value: Any, key: str = "") -> Any:
    if SENSITIVE_KEY.search(key):
        return "[REDACTED]"
    if isinstance(value, dict):
        return {str(name): redact(item, str(name)) for name, item in value.items()}
    if isinstance(value, list):
        return [redact(item, key) for item in value]
    if isinstance(value, str):
        return redact_text(value)
    return value


def regression_proposal(incident: dict[str, Any]) -> dict[str, Any]:
    safe = redact(incident)
    cause = safe.get("why_prior_proof_missed") or safe.get("root_cause") or "unknown"
    return {
        "version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source_id": safe.get("id"),
        "classification": safe.get("classification", "reopened_defect"),
        "sanitized_evidence": safe,
        "gap": cause,
        "recommended_change_surface": safe.get("change_surface", "evaluation_and_applicable_workflow"),
        "regression_case": {
            "id": safe.get("regression_id", f"regression-{safe.get('id', 'unassigned')}"),
            "task": safe.get("task") or safe.get("symptom") or "Reproduce the sanitized failure.",
            "must_do": safe.get("must_do", ["reproduce failure", "prove root cause", "add regression evidence", "verify neighboring paths"]),
            "must_not": safe.get("must_not", ["store secrets or personal data", "claim complete without closing the evidence gap"]),
        },
        "review_required": True,
        "policy": "A human or authorized maintainer reviews the sanitized proposal before adding it to persistent Skill fixtures.",
    }


def evaluate_artifact(case: dict[str, Any], artifact: dict[str, Any]) -> dict[str, Any]:
    evidenced = set(artifact.get("evidenced", []))
    avoided = set(artifact.get("avoided", []))
    must_do = set(case.get("must_do", []))
    must_not = set(case.get("must_not", []))
    checks = {
        "must_do": sorted(must_do & evidenced),
        "missing": sorted(must_do - evidenced),
        "must_not_avoided": sorted(must_not & avoided),
        "forbidden_unaccounted": sorted(must_not - avoided),
    }
    passed = not checks["missing"] and not checks["forbidden_unaccounted"] and bool(artifact.get("diff_or_answer_review", {}).get("passed")) and bool(artifact.get("evidence_integrity", {}).get("passed"))
    return {"passed": passed, "case_id": case.get("id"), "checks": checks, "limitations": ["Label scoring verifies declared evidence coverage; independent model/diff review is still required."]}


def compare_artifacts(case: dict[str, Any], baseline: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any]:
    """Compare two independently reviewed artifacts without pretending to run a model."""
    before = evaluate_artifact(case, baseline)
    after = evaluate_artifact(case, candidate)
    dimensions = case.get("rubric", ["intent", "correctness", "security", "verification", "experience", "evidence_integrity"])
    baseline_scores = baseline.get("scores", {})
    candidate_scores = candidate.get("scores", {})
    deltas = {name: candidate_scores.get(name, 0) - baseline_scores.get(name, 0) for name in dimensions}
    regressions = sorted(name for name, delta in deltas.items() if delta < 0)
    improvements = sorted(name for name, delta in deltas.items() if delta > 0)
    return {"passed": after["passed"] and not regressions, "case_id": case.get("id"), "baseline": before, "candidate": after, "score_deltas": deltas, "improvements": improvements, "regressions": regressions, "claim": "paired_review_measurement", "limitations": ["Artifacts and scores must come from blinded or independently reviewed runs.", "This command does not execute or judge language models by itself."]}
