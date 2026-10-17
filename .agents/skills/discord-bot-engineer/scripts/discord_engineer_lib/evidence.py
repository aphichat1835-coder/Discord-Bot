from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def receipt(*, command: str, checks: dict[str, Any], findings: list[dict[str, Any]] | None = None, unknowns: list[str] | None = None) -> dict[str, Any]:
    return {
        "version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "command": command,
        "checks": checks,
        "findings": findings or [],
        "unknowns": unknowns or [],
        "claim": "evidence_recorded_not_absolute_proof",
    }
