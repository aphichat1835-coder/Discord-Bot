from __future__ import annotations

import hashlib
import json
from typing import Any

from .manifest import manifest
from .schema_validation import validate_named


TERMINAL_STATES = {"empty", "partial", "succeeded", "permission_denied", "failed", "cancelled", "timed_out", "closed", "resolved"}
STATE_COLORS = {"working": 0x5865F2, "playing": 0x5865F2, "succeeded": 0x23A55A, "resolved": 0x23A55A, "partial": 0xF0B232, "warning": 0xF0B232, "failed": 0xF23F43, "permission_denied": 0xF23F43, "cancelled": 0x80848E, "timed_out": 0x80848E}


def _auto_direction(command_type: str) -> str:
    if command_type in {"moderation", "security"}:
        return "tactical_admin"
    if command_type in {"information"}:
        return "editorial_information"
    if command_type in {"music"}:
        return "playful_community"
    if command_type in {"economy"}:
        return "premium_dark"
    return "discord_native"


def _fingerprint(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return "visual-sha256:" + hashlib.sha256(encoded).hexdigest()


def make_visual_plan(*, purpose: str, command_type: str = "generic", surface: str = "components_v2", direction: str = "auto", panel: str = "auto", density: str = "balanced", brand_intensity: str = "medium", taste: dict[str, Any] | None = None) -> dict[str, Any]:
    patterns = manifest("command-experience-patterns.json")["patterns"]
    directions = manifest("visual-directions.json")["directions"]
    copy_voice = manifest("copy-voice.json")
    panels = manifest("panel-archetypes.json")
    if command_type not in patterns:
        raise ValueError(f"unsupported command type: {command_type}")
    if density not in {"compact", "balanced", "comfortable", "spacious"}:
        raise ValueError(f"unsupported density: {density}")
    if brand_intensity not in {"low", "medium", "high"}:
        raise ValueError(f"unsupported brand intensity: {brand_intensity}")
    taste = taste or {}
    taste_errors = validate_named(taste, "taste-profile.schema.json") if taste else []
    if taste_errors:
        raise ValueError("invalid taste profile: " + "; ".join(taste_errors))
    density = str(taste.get("density", density))
    brand_intensity = str(taste.get("brand_intensity", brand_intensity))
    preferred = [item for item in taste.get("preferred_directions", []) if item in directions]
    selected = (preferred[0] if preferred else _auto_direction(command_type)) if direction == "auto" else direction
    if selected not in directions:
        raise ValueError(f"unsupported visual direction: {selected}")
    rejected: list[dict[str, str]] = []
    if selected in taste.get("avoid_directions", []) or command_type in directions[selected].get("avoid", []):
        rejected.append({"direction": selected, "reason": f"direction conflicts with {command_type} context"})
        selected = _auto_direction(command_type)
    compatible = [
        name for name, config in directions.items()
        if command_type not in config.get("avoid", []) and name != selected
    ][:2]
    pattern = patterns[command_type]
    selected_panel = ("form_modal" if surface == "modal" else pattern["panel"]) if panel == "auto" else panel
    if selected_panel not in panels["panels"]:
        raise ValueError(f"unsupported panel: {selected_panel}")
    copy_tier = "operational" if command_type in {"moderation", "security", "economy"} else ("contextual" if command_type in {"setup", "music", "ticket"} else "brief")
    identity = {
        "command_type": command_type,
        "surface": surface,
        "direction": selected,
        "recipe": pattern["recipe"],
        "panel": selected_panel,
        "density": density,
        "brand_intensity": brand_intensity,
        "taste": {"profile": taste.get("name"), "prefer": taste.get("prefer", []), "avoid": taste.get("avoid", []), "applied": bool(taste)},
        "hierarchy": pattern["hierarchy"],
    }
    return {
        "version": 1,
        "purpose": purpose,
        "command_type": command_type,
        "surface": surface,
        "direction": {"id": selected, **directions[selected], "alternatives": compatible, "rejected": rejected},
        "pattern": {**pattern, "panel": selected_panel, "panel_contract": panels["panels"][selected_panel], "panel_selection_rules": panels["selection_rules"], "recipe_contract": manifest("components-v2-recipes.json")["recipes"][pattern["recipe"]]},
        "component_palette": manifest("discord-component-palette.json"),
        "copy": {"tier": copy_tier, **copy_voice["tiers"][copy_tier], "placements": copy_voice["placements"], "emoji": copy_voice["emoji"]},
        "density": density,
        "brand_intensity": brand_intensity,
        "taste": identity["taste"],
        "variation": {"fingerprint": _fingerprint(identity), "identity": identity, "rule": "Vary composition by job and hierarchy; preserve shared tokens and interaction behavior."},
        "proof": ["all_reachable_states", "Discord_client_wide_and_narrow", "long_Thai_and_English", "control_ownership_and_expiry", "copy_density_by_placement", "visual_comparison_against_sibling_commands"],
        "limitations": ["A plan selects a defensible direction; it does not prove visual quality until rendered and reviewed in a Discord client."],
    }


def _component_count(component: dict[str, Any]) -> int:
    count = 1
    for child in component.get("components", []):
        if isinstance(child, dict):
            count += _component_count(child)
    accessory = component.get("accessory")
    if isinstance(accessory, dict):
        count += _component_count(accessory)
    return count


def _text_count(component: dict[str, Any]) -> int:
    count = len(str(component.get("content", "")))
    for child in component.get("components", []):
        if isinstance(child, dict):
            count += _text_count(child)
    return count


def compose_components_v2(spec: dict[str, Any]) -> dict[str, Any]:
    schema_errors = validate_named(spec, "components-v2-spec.schema.json")
    findings = [{"level": "error", "rule": "schema", "message": error} for error in schema_errors]
    limits = manifest("components-v2-recipes.json")["limits"]
    actions = spec.get("actions", []) if isinstance(spec.get("actions", []), list) else []
    seen_ids: set[str] = set()
    for index, action in enumerate(actions):
        if not isinstance(action, dict):
            continue
        style = action.get("style")
        custom_id = action.get("custom_id")
        url = action.get("url")
        sku_id = action.get("sku_id")
        if style == 6:
            if not sku_id or any((custom_id, url, action.get("label"))):
                findings.append({"level": "error", "rule": "premium_button", "message": f"actions[{index}] premium button requires sku_id and forbids label, custom_id, and url"})
        elif style == 5:
            if not url or custom_id:
                findings.append({"level": "error", "rule": "link_button", "message": f"actions[{index}] link button requires url and forbids custom_id"})
        elif not action.get("label") or not custom_id or url or sku_id:
            findings.append({"level": "error", "rule": "interactive_button", "message": f"actions[{index}] interactive button requires custom_id and forbids url"})
        if custom_id in seen_ids:
            findings.append({"level": "error", "rule": "duplicate_custom_id", "message": f"actions[{index}] repeats custom_id"})
        if custom_id:
            seen_ids.add(str(custom_id))
    if findings:
        return {"version": 1, "valid": False, "payload": {}, "findings": findings}

    state = str(spec.get("state", "working"))
    terminal = state in TERMINAL_STATES
    title = str(spec["title"])
    summary = spec.get("summary")
    header = f"# {title}" + (f"\n{summary}" if summary else "")
    children: list[dict[str, Any]] = []
    thumbnail = spec.get("thumbnail_url")
    if thumbnail:
        children.append({"type": 9, "components": [{"type": 10, "content": header}], "accessory": {"type": 11, "media": {"url": str(thumbnail)}, "description": title[:1024]}})
    else:
        children.append({"type": 10, "content": header})

    facts = spec.get("facts", [])
    if facts:
        fact_text = "\n".join(f"**{item['label']}:** {item['value']}" for item in facts)
        children.extend([{"type": 14, "divider": True, "spacing": 1}, {"type": 10, "content": fact_text}])
    for detail in spec.get("details", []):
        children.append({"type": 10, "content": str(detail)})
    media = spec.get("media", [])
    if media:
        children.append({"type": 12, "items": [{"media": {"url": str(item["url"])}, **({"description": item["description"]} if item.get("description") else {}), **({"spoiler": True} if item.get("spoiler") else {})} for item in media]})
    if actions:
        buttons = []
        for action in actions:
            button = {"type": 2, "style": action["style"]}
            if action.get("label"):
                button["label"] = action["label"]
            if action.get("custom_id"):
                button["custom_id"] = action["custom_id"]
                button["disabled"] = bool(action.get("disabled")) or terminal
            if action.get("url"):
                button["url"] = action["url"]
            if action.get("sku_id"):
                button["sku_id"] = action["sku_id"]
            buttons.append(button)
        children.append({"type": 1, "components": buttons})

    accent = spec.get("accent_color")
    if accent is None:
        accent = STATE_COLORS.get(state, 0x5865F2)
    container = {"type": 17, "accent_color": accent, "components": children}
    total_components = _component_count(container)
    text_total = _text_count(container)
    if total_components > limits["total_components"]:
        findings.append({"level": "error", "rule": "component_count", "message": f"payload has {total_components} components; limit is {limits['total_components']}"})
    if text_total > 4000:
        findings.append({"level": "error", "rule": "reviewed_text_budget", "message": "Text Display content exceeds the Skill's conservative 4000-character review budget"})
    payload = {} if findings else {"flags": 32768, "components": [container], "allowed_mentions": {"parse": []}}
    return {
        "version": 1,
        "valid": not findings,
        "state": state,
        "terminal": terminal,
        "component_count": total_components,
        "payload": payload,
        "findings": findings,
        "proof_required": ["installed_framework_builder_or_schema", "actual_Discord_client", "wide_and_narrow_content", "interaction_ownership_and_expiry"],
        "platform_basis": "Discord Components V2: flag 1<<15; Container/Text Display/Section/Thumbnail/Media Gallery/Separator/Action Row; max 40 total components.",
    }


def compare_visual_plans(plans: list[dict[str, Any]]) -> dict[str, Any]:
    rubric = manifest("visual-quality-rubric.json")
    results = []
    fingerprints: dict[str, int] = {}
    for index, plan in enumerate(plans):
        errors = validate_named(plan, "visual-experience-plan.schema.json")
        fingerprint = str(plan.get("variation", {}).get("fingerprint", ""))
        duplicate_of = fingerprints.get(fingerprint) if fingerprint else None
        if fingerprint and duplicate_of is None:
            fingerprints[fingerprint] = index
        results.append({
            "index": index,
            "valid": not errors,
            "direction": plan.get("direction", {}).get("id"),
            "recipe": plan.get("pattern", {}).get("recipe"),
            "density": plan.get("density"),
            "copy_tier": plan.get("copy", {}).get("tier"),
            "duplicate_of": duplicate_of,
            "schema_errors": errors,
        })
    distinct = len({item.get("variation", {}).get("fingerprint") for item in plans if item.get("variation", {}).get("fingerprint")})
    return {
        "version": 1,
        "passed": bool(plans) and all(item["valid"] for item in results) and distinct == len(plans),
        "variants": results,
        "distinct_fingerprints": distinct,
        "rubric": rubric,
        "selection": "human_or_rendered_review_required",
        "limitations": ["Structural comparison detects invalid or duplicate directions; it cannot score beauty without rendered evidence and user judgment."],
    }
