from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .manifest import manifest
from .io_utils import SOURCE_SUFFIXES, read_text, relative, walk_files


STATE_SETS = {
    "result": ["idle", "working", "empty", "succeeded", "permission_denied", "failed", "timed_out"],
    "operational_status": ["validating", "queued", "working", "partial", "succeeded", "recoverable_error", "permission_denied", "failed", "cancelled", "timed_out"],
    "destructive_confirmation": ["confirming", "validating", "working", "partial", "succeeded", "permission_denied", "failed", "cancelled", "timed_out"],
    "error_recovery": ["failed", "recovering", "succeeded", "terminal_error", "timed_out"],
    "settings": ["idle", "dirty", "validating", "saving", "succeeded", "permission_denied", "failed", "timed_out"],
}

DISCORD_PAYLOAD_LIMITS = {"plain": 2000, "ephemeral": 2000, "embed": 4096, "components_v2": 4000, "legacy_components": 2000}
TERMINAL_UX_STATES = {"empty", "partial", "succeeded", "permission_denied", "failed", "terminal_error", "cancelled", "timed_out"}
SEMANTIC_COLORS = {"working": 0x5865F2, "succeeded": 0x23A55A, "partial": 0xF0B232, "permission_denied": 0xF23F43, "failed": 0xF23F43, "cancelled": 0x80848E, "timed_out": 0x80848E}


def decide_ux(*, surface: str, purpose: str, duration_ms: int | None = None, total_known: bool = False, new_user: bool = False, destructive: bool = False) -> dict[str, Any]:
    if duration_ms is not None and duration_ms < 0:
        raise ValueError("duration_ms must be non-negative")
    purpose = purpose.lower()
    surfaces = manifest("ux-surfaces.json")["surfaces"]
    panels = manifest("panel-archetypes.json")["panels"]
    loading_policies = {item["id"]: item for item in manifest("loading-policies.json")["policies"]}
    motion_profiles = manifest("motion-profiles.json")["profiles"]
    onboarding_patterns = manifest("onboarding-patterns.json")["patterns"]
    feedback_patterns = manifest("feedback-patterns.json")["patterns"]
    copy_voice = manifest("copy-voice.json")
    if surface not in surfaces:
        raise ValueError(f"unknown surface: {surface}")
    if destructive:
        panel = "destructive_confirmation"
    elif any(x in purpose for x in ("setting", "config", "ตั้งค่า", "กำหนดค่า")):
        panel = "settings"
    elif any(x in purpose for x in ("progress", "job", "process", "delete", "purge", "ความคืบหน้า", "ประมวลผล", "ลบ")):
        panel = "operational_status"
    elif any(x in purpose for x in ("error", "fail", "recover", "ข้อผิดพลาด", "ล้มเหลว", "กู้คืน")):
        panel = "error_recovery"
    else:
        panel = "result"
    if total_known:
        loading_policy = loading_policies["known_total"]
    elif duration_ms is not None and duration_ms <= 700:
        loading_policy = loading_policies["instant"]
    elif surface == "dashboard" and any(x in purpose for x in ("initial", "list", "table")):
        loading_policy = loading_policies["structured_initial_load"]
    else:
        loading_policy = loading_policies["short_unknown"]
    motion = "productive" if surface == "dashboard" else "none"
    onboarding = "contextual_hint" if new_user else None
    if destructive or total_known:
        copy_tier = "operational"
    elif panel in {"operational_status", "error_recovery", "settings"}:
        copy_tier = "contextual"
    else:
        copy_tier = "brief"
    copy_contract = copy_voice["tiers"][copy_tier]
    return {
        "version": 1,
        "surface": surface,
        "surface_contract": surfaces[surface],
        "panel": panel,
        "panel_contract": panels[panel],
        "loading": {"policy": loading_policy["id"], "pattern": loading_policy["pattern"], "reason": loading_policy["reason"], "truthful": True, "fake_percentage": False},
        "motion": {"profile": motion, "contract": motion_profiles[motion], "reduced_motion_equivalent": surface == "dashboard", "motion_only_meaning": False},
        "onboarding": {"pattern": onboarding, "contract": onboarding_patterns[onboarding]} if onboarding else None,
        "feedback_contract": {name: feedback_patterns[name] for name in ("working", "success", "partial", "failure", "cancelled", "timeout")},
        "copy": {"tier": copy_tier, **copy_contract, "placements": copy_voice["placements"], "emoji": copy_voice["emoji"]},
        "copy_rules": [*copy_contract["rules"], "no_fake_certainty", "locale_ready"],
        "states": STATE_SETS[panel],
        "ownership": {"bind_interactive_controls_to_actor": True, "expire_or_disable_terminal_controls": True},
        "platform_evidence": "confirm version-sensitive component behavior from current official Discord docs or installed framework types",
    }


def validate_ux(data: dict[str, Any]) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    surface = data.get("surface")
    if surface not in manifest("ux-surfaces.json")["surfaces"]:
        findings.append({"level": "error", "rule": "surface", "message": "Unknown UX surface."})
    motion = data.get("motion", {})
    if surface != "dashboard" and motion.get("profile") not in (None, "none"):
        findings.append({"level": "error", "rule": "discord_motion", "message": "Discord-rendered surfaces cannot provide arbitrary UI animation."})
    loading = data.get("loading", {})
    if loading.get("fake_percentage"):
        findings.append({"level": "error", "rule": "fake_progress", "message": "Progress must be based on real work units."})
    if motion.get("motion_only_meaning"):
        findings.append({"level": "error", "rule": "motion_only_meaning", "message": "Provide a static equivalent for status and meaning."})
    states = data.get("states", [])
    if not isinstance(states, list) or not states:
        findings.append({"level": "error", "rule": "state_matrix", "message": "Define the applicable loading, success, failure, empty, denial, and recovery states."})
    ownership = data.get("ownership", {})
    if surface in {"legacy_components", "components_v2", "modal"} and not ownership.get("bind_interactive_controls_to_actor"):
        findings.append({"level": "error", "rule": "component_ownership", "message": "Interactive controls must define actor/session ownership or an explicit public-control policy."})
    for control in data.get("controls", []):
        custom_id = control.get("custom_id")
        if custom_id is not None and not (1 <= len(str(custom_id)) <= 100):
            findings.append({"level": "error", "rule": "custom_id_length", "message": "Discord custom_id must be 1-100 characters."})
        label = control.get("label")
        if label is not None and len(str(label)) > 80:
            findings.append({"level": "error", "rule": "button_label_length", "message": "Discord button label exceeds the platform maximum of 80 characters."})
    if surface == "components_v2" and (data.get("content") or data.get("embeds")):
        findings.append({"level": "error", "rule": "components_v2_mixed_payload", "message": "IS_COMPONENTS_V2 messages cannot mix traditional content or embeds with component-driven content."})
    return findings


def compile_ux(decision: dict[str, Any], framework: str) -> dict[str, Any]:
    """Compile a surface decision into a framework-neutral, testable state contract."""
    findings = validate_ux(decision)
    states = []
    for name in decision.get("states", []):
        terminal = name in TERMINAL_UX_STATES
        states.append({
            "name": name,
            "terminal": terminal,
            "message_policy": "cause_impact_next_action" if "error" in name or name == "failed" else "specific_status",
            "controls": "disabled_or_removed" if terminal else "only_actions_valid_in_state",
            "progress": "real_work_units_only" if name == "working" else "none_or_state_specific",
        })
    adapters = {
        "discord.js": {"acknowledge": "deferReply/reply", "update": "editReply/followUp", "response_state": "interaction.deferred || interaction.replied"},
        "discord.py": {"acknowledge": "interaction.response.defer/send_message", "update": "edit_original_response/followup.send", "response_state": "interaction.response.is_done()"},
        "dashboard": {"acknowledge": "optimistic_or_pending_state", "update": "state/store transition", "response_state": "request/job state"},
    }
    return {
        "version": 1,
        "valid": not any(item["level"] == "error" for item in findings),
        "framework": framework,
        "surface": decision.get("surface"),
        "panel": decision.get("panel"),
        "states": states,
        "adapter": adapters.get(framework, {"status": "unsupported_framework_requires_adapter"}),
        "copy_contract": decision.get("copy", {"rules": decision.get("copy_rules", [])}),
        "proof": ["state_snapshot", "denial_and_expiry", "locale_expansion", "mobile_or_narrow_view" if decision.get("surface") == "dashboard" else "Discord_client_review"],
        "findings": findings,
    }


def compile_discord_payload(decision: dict[str, Any], *, summary: str, detail: str | None = None, state: str = "working", custom_id: str | None = None, button_label: str = "Cancel") -> dict[str, Any]:
    """Compile a concrete REST-shaped Discord payload for snapshot tests.

    The output intentionally uses raw Discord component types so it can be adapted to
    either discord.js or discord.py after checking the installed framework version.
    """
    surface = decision.get("surface")
    terminal = state in TERMINAL_UX_STATES
    controls = []
    if custom_id:
        controls.append({"custom_id": custom_id, "label": button_label})
    check_input = {**decision, "controls": controls}
    findings = validate_ux(check_input)
    if state not in decision.get("states", []):
        findings.append({"level": "error", "rule": "unreachable_state", "message": f"State {state!r} is not declared by this UX decision."})
    text = summary if not detail else f"**{summary}**\n{detail}"
    if surface not in DISCORD_PAYLOAD_LIMITS:
        findings.append({"level": "error", "rule": "unsupported_payload_surface", "message": f"Surface {surface!r} needs its own compiler; this command emits Discord message payloads only."})
    elif len(text) > DISCORD_PAYLOAD_LIMITS[surface]:
        findings.append({"level": "error", "rule": "payload_text_length", "message": f"Payload text exceeds the reviewed {surface} limit of {DISCORD_PAYLOAD_LIMITS[surface]} characters."})
    if custom_id and surface not in {"legacy_components", "components_v2", "ephemeral"}:
        findings.append({"level": "error", "rule": "control_surface", "message": f"Interactive controls are not compiled for surface {surface!r}."})

    if any(item["level"] == "error" for item in findings):
        payload: dict[str, Any] = {}
    elif surface == "components_v2":
        components: list[dict[str, Any]] = [{"type": 10, "content": text}]
        if custom_id:
            components.append({"type": 1, "components": [{"type": 2, "style": 2, "label": button_label, "custom_id": custom_id, "disabled": terminal}]})
        payload = {"flags": 32768, "components": components, "allowed_mentions": {"parse": []}}
    elif surface == "embed":
        payload = {"embeds": [{"description": text, "color": SEMANTIC_COLORS.get(state, 0x5865F2)}], "allowed_mentions": {"parse": []}}
    else:
        payload = {"content": text, "allowed_mentions": {"parse": []}}
        if surface == "ephemeral":
            payload["flags"] = 64
        if custom_id and surface in {"legacy_components", "ephemeral"}:
            payload["components"] = [{"type": 1, "components": [{"type": 2, "style": 2, "label": button_label, "custom_id": custom_id, "disabled": terminal}]}]
    return {"version": 1, "valid": not any(item["level"] == "error" for item in findings), "surface": surface, "state": state, "terminal": terminal, "payload": payload, "findings": findings, "proof_required": ["schema_or_framework_builder_validation", "Discord_client_snapshot", "ownership_and_expiry_behavior"], "platform_boundary": "Verify raw payload fields against current official Discord docs and installed framework types before production use."}


def audit_experience(root: Path, max_files: int = 4000) -> dict[str, Any]:
    patterns = [
        ("generic_error_copy", re.compile(r"(?i)(something went wrong|เกิดข้อผิดพลาด(?:ขึ้น)?\s*(?:กรุณา)?ลองใหม่)"), "Error copy should explain cause, impact, and a safe next action."),
        ("fake_progress_literal", re.compile(r"(?i)(progress|percent|percentage)\s*[:=]\s*(?:50|75|90|99)\b"), "Confirm progress is derived from real work units."),
        ("decorative_gradient", re.compile(r"(?i)(linear-gradient|radial-gradient)\([^;]{0,200}(?:#7c3aed|#8b5cf6|purple|violet)"), "Verify that the gradient belongs to the product direction instead of a generic AI-dashboard default."),
        ("excessive_glass", re.compile(r"(?i)backdrop-filter\s*:\s*blur"), "Blur/glass treatment needs contrast, performance, and brand justification."),
    ]
    findings: list[dict[str, Any]] = []
    scanned = 0
    suffixes = SOURCE_SUFFIXES | {".css", ".scss", ".html", ".vue", ".svelte"}
    for path in walk_files(root, suffixes=suffixes, max_files=max_files):
        text = read_text(path)
        if text is None:
            continue
        scanned += 1
        for rule, pattern, message in patterns:
            for match in pattern.finditer(text):
                findings.append({"severity": "review", "rule": rule, "path": relative(root, path), "line": text.count("\n", 0, match.start()) + 1, "message": message, "confidence": "tentative"})
    return {"version": 1, "root": str(root.resolve()), "scanned_files": scanned, "findings": findings, "required_review": ["user_flow", "information_hierarchy", "state_matrix", "responsive_or_client_surface", "accessibility", "copy_voice", "visual_evidence"], "limitations": ["Taste findings are review prompts, not objective proof of poor design."]}


def experience_gate(review: dict[str, Any]) -> dict[str, Any]:
    required = ["flow", "states", "responsive_or_surface", "accessibility", "copy", "visual_evidence", "truthful_feedback"]
    checks = {name: bool(review.get("checks", {}).get(name, {}).get("passed")) for name in required}
    if review.get("major_redesign"):
        checks["direction_accepted"] = bool(review.get("checks", {}).get("direction_accepted", {}).get("passed"))
    passed = all(checks.values()) and not review.get("unknowns") and not review.get("blockers")
    return {"passed": passed, "checks": checks, "claim": "experience_accepted" if passed else "experience_not_verified", "unknowns": review.get("unknowns", []), "blockers": review.get("blockers", [])}
