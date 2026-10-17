from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import re
from typing import Any

from .manifest import manifest
from .io_utils import SOURCE_SUFFIXES, read_text, relative, walk_files


DOMAIN_PROFILES = {"moderation", "verification", "tickets", "economy", "music", "dashboard", "monetization", "distributed", "interactions"}

DOMAIN_SIGNALS = {
    "moderation": {"actor_permission": r"has_permissions|PermissionFlagsBits|permissions\.has", "bot_permission": r"bot_has_permissions|me\.permissions|botPermissions", "role_hierarchy": r"top_role|highest\.position|roles\.highest|comparePositionTo", "partial_truth": r"partial|failed|skipped|errors?"},
    "verification": {"single_use_state": r"used_at|consumed|single.?use|delete.*challenge", "expiry": r"expires_at|expiresAt|timeout|ttl", "identity_binding": r"user_id|userId|member\.id|interaction\.user\.id", "least_data": r"hash|digest|redact|delete.*token"},
    "tickets": {"durable_ticket_state": r"ticket.*(?:state|status)|(?:database|repository|model).*ticket", "serialized_close": r"lock|mutex|transaction|closing", "recoverable_transcript": r"transcript.*(?:save|store|upload)|archive"},
    "economy": {"exact_amount": r"Decimal|BigInt|integer|cents|minor.?units", "atomic_transaction": r"transaction|BEGIN|atomic", "idempotency": r"idempoten|unique.*(?:key|constraint)|request_id", "ledger": r"ledger|journal|audit.*entry"},
    "music": {"guild_owner": r"guildId|guild_id", "explicit_player_state": r"player.*state|queue.*state|playing|paused", "bounded_media": r"timeout|max.*(?:size|duration)|abort", "terminal_cleanup": r"destroy|disconnect|cleanup|finally"},
    "dashboard": {"server_identity": r"guildId|guild_id", "current_authorization": r"permission|authorize|guilds/@me", "csrf_state": r"csrf|state.*(?:verify|nonce)|pkce", "least_scope": r"scope|identify|guilds"},
    "monetization": {"authoritative_entitlement": r"entitlement|subscription.*(?:fetch|verify)", "idempotent_fulfillment": r"idempoten|event_id|unique.*event", "revocation": r"revoke|refund|cancelled|expired"},
    "distributed": {"external_ownership": r"owner_id|worker_id|shard_id", "idempotent_job": r"idempoten|job_id|dedup", "lease_fencing": r"lease|fencing|generation|epoch", "restart_recovery": r"resume|recover|requeue|startup"},
    "interactions": {"acknowledge_once": r"deferReply|reply\(|send_message|response\.defer", "authorize_at_action": r"permission|authorize|owner_id|user\.id", "terminal_state": r"terminal|completed|cancelled|disable"},
}


def analyze_domain(root: Path, profile: str, max_files: int = 4000) -> dict[str, Any]:
    if profile not in DOMAIN_SIGNALS:
        raise ValueError(f"unsupported domain profile: {profile}")
    corpus: list[tuple[str, str]] = []
    for path in walk_files(root, suffixes=SOURCE_SUFFIXES, max_files=max_files):
        text = read_text(path)
        if text is not None:
            corpus.append((relative(root, path), text))
    invariants = []
    for invariant, expression in DOMAIN_SIGNALS[profile].items():
        pattern = re.compile(expression, re.I)
        evidence = []
        for path, text in corpus:
            match = pattern.search(text)
            if match:
                evidence.append({"path": path, "line": text.count("\n", 0, match.start()) + 1, "excerpt": match.group(0)[:120]})
        invariants.append({"id": invariant, "status": "candidate_evidence" if evidence else "not_observed", "evidence": evidence[:20], "confidence": "tentative"})
    return {"version": 1, "profile": profile, "root": str(root.resolve()), "scanned_files": len(corpus), "invariants": invariants, "claim": "review_leads_only", "required_next": ["trace each invariant through control flow", "exercise negative and partial-failure scenarios", "confirm durable/runtime behavior"], "limitations": ["Text signals cannot prove an invariant is correctly enforced."]}


def make_domain_contract(profile: str, request: str) -> dict[str, Any]:
    profiles = manifest("profiles.json").get("profiles", {})
    if profile not in DOMAIN_PROFILES or profile not in profiles:
        raise ValueError(f"unsupported domain profile: {profile}")
    config = profiles[profile]
    security_profile = config.get("security")
    security_scenarios = manifest("security-profiles.json").get("profiles", {}).get(security_profile, []) if security_profile else []
    return {
        "version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "profile": profile,
        "request": request,
        "risk": config.get("risk", "medium"),
        "invariants": [{"id": item, "status": "pending", "evidence": []} for item in config.get("invariants", [])],
        "scenarios": [{"id": item, "status": "pending", "evidence": []} for item in config.get("tests", [])],
        "security_scenarios": [{"id": item, "status": "pending", "evidence": []} for item in security_scenarios],
        "boundaries": ["authorization", "durable_state", "side_effects", "partial_failure", "cleanup_and_recovery", "user_visible_truth"],
        "live_boundary": {"level": "not_run", "evidence": []},
        "status": "draft_requires_project_evidence",
    }


def domain_gate(contract: dict[str, Any], evidence: dict[str, Any]) -> dict[str, Any]:
    invariants = evidence.get("invariants", contract.get("invariants", []))
    scenarios = evidence.get("scenarios", contract.get("scenarios", []))
    security_scenarios = evidence.get("security_scenarios", contract.get("security_scenarios", []))
    accepted = {"passed", "verified", "not_applicable"}
    checks = {
        "invariants": bool(invariants) and all(item.get("status") in accepted for item in invariants),
        "scenarios": bool(scenarios) and all(item.get("status") in accepted for item in scenarios),
        "authorization": bool(evidence.get("authorization", {}).get("passed")),
        "state_and_side_effects": bool(evidence.get("state_and_side_effects", {}).get("passed")),
        "recovery": bool(evidence.get("recovery", {}).get("passed")),
        "user_visible_truth": bool(evidence.get("user_visible_truth", {}).get("passed")),
    }
    if security_scenarios:
        checks["security_scenarios"] = all(item.get("status") in accepted for item in security_scenarios)
    blockers = evidence.get("blockers", [])
    passed = all(checks.values()) and not evidence.get("unknowns") and not blockers
    return {"passed": passed, "profile": contract.get("profile"), "checks": checks, "claim": "domain_invariants_verified" if passed else "domain_not_verified", "live_boundary": evidence.get("live_boundary", contract.get("live_boundary", {})), "unknowns": evidence.get("unknowns", []), "blockers": blockers}
