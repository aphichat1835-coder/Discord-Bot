from __future__ import annotations

from typing import Any

TERMINAL = {"succeeded", "partial", "failed", "cancelled", "timed_out", "permission_denied"}


def run_scenario(scenario: dict[str, Any]) -> dict[str, Any]:
    state = "received"
    acknowledged = 0
    effects: list[str] = []
    violations: list[str] = []
    trace: list[dict[str, Any]] = []
    authorized = False
    for index, step in enumerate(scenario.get("steps", [])):
        action = step.get("action")
        if action in {"reply", "defer", "update"}:
            acknowledged += 1
            if acknowledged > 1:
                violations.append("interaction acknowledged more than once")
            state = "acknowledged"
        elif action == "authorize":
            authorized = bool(step.get("allowed"))
            state = "running" if authorized else "permission_denied"
        elif action == "effect":
            if not authorized:
                violations.append("side effect occurred before authorization")
            key = str(step.get("idempotency_key", ""))
            if key and key in effects:
                violations.append("duplicate idempotency key")
            effects.append(key)
            state = "running"
        elif action in TERMINAL:
            state = action
        elif action == "cancel":
            state = "cancelled"
        else:
            violations.append(f"unknown action: {action}")
        trace.append({"step": index, "action": action, "state": state})
    if state not in TERMINAL:
        violations.append("scenario has no terminal state")
    expected = scenario.get("expect", {})
    if expected.get("state") and expected["state"] != state:
        violations.append(f"expected state {expected['state']}, got {state}")
    return {"id": scenario.get("id"), "passed": not violations, "state": state, "violations": violations, "trace": trace}
