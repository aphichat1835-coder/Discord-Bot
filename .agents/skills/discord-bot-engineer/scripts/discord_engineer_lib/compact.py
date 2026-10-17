from __future__ import annotations

from collections import Counter
from typing import Any


PRIORITY = {"critical": 0, "error": 1, "high": 2, "warning": 3, "medium": 4, "review": 5, "info": 6, "low": 7}


def _trim_finding(item: dict[str, Any]) -> dict[str, Any]:
    allowed = ("severity", "level", "rule", "path", "line", "message", "confidence", "id", "status", "passed")
    return {key: item[key] for key in allowed if key in item}


def _compact_check(value: Any, depth: int = 0) -> Any:
    if isinstance(value, (str, int, float, bool, type(None))):
        return value
    if isinstance(value, list):
        return {"count": len(value)}
    if not isinstance(value, dict) or depth >= 3:
        return {"present": bool(value)}
    result = {key: value[key] for key in ("passed", "attempted", "status", "claim", "required") if key in value}
    commands = value.get("commands")
    if isinstance(commands, list):
        failed = []
        for item in commands:
            if isinstance(item, dict) and item.get("passed") is False:
                failure = {key: item.get(key) for key in ("id", "command", "returncode", "error") if item.get(key) is not None}
                if item.get("output_tail"):
                    failure["output_tail"] = str(item["output_tail"])[-800:]
                failed.append(failure)
        result["commands"] = {"count": len(commands), "failed": failed}
    for key, item in value.items():
        if key in result or key == "commands":
            continue
        if key in {"scenario_checks", "manual_or_live", "unknowns", "blockers"} and isinstance(item, list):
            result[key] = item[:8]
        elif isinstance(item, dict):
            result[key] = _compact_check(item, depth + 1)
    return result or {"present": True}


def compact_result(value: Any, *, max_findings: int = 8, only_blockers: bool = False, artifact_path: str | None = None) -> Any:
    """Return a deterministic context view while leaving the source artifact untouched."""
    if not isinstance(value, dict):
        return value
    result: dict[str, Any] = {"view": "compact"}
    for key in ("version", "passed", "valid", "claim", "status", "state", "level", "risk", "root", "profile", "case_id", "scanned_files", "benchmark_cases", "confidence"):
        if key in value:
            result[key] = value[key]
    if artifact_path:
        result["full_artifact"] = artifact_path
    findings = value.get("findings")
    if isinstance(findings, list):
        counts = Counter(str(item.get("severity") or item.get("level") or "unspecified") for item in findings if isinstance(item, dict))
        ordered = sorted((item for item in findings if isinstance(item, dict)), key=lambda item: (PRIORITY.get(str(item.get("severity") or item.get("level")), 99), str(item.get("path", "")), int(item.get("line", 0) or 0)))
        if only_blockers:
            ordered = [item for item in ordered if str(item.get("severity") or item.get("level")) in {"critical", "error", "high"}]
        result["finding_summary"] = {"total": len(findings), "by_severity": dict(sorted(counts.items())), "shown": min(len(ordered), max_findings)}
        result["findings"] = [_trim_finding(item) for item in ordered[:max_findings]]
    for key in ("unknowns", "blockers", "limitations", "manifest_errors", "benchmark_errors"):
        if key in value:
            items = value[key]
            result[key] = items[:max_findings] if isinstance(items, list) else items
    if "checks" in value:
        result["checks"] = {name: _compact_check(check) for name, check in value["checks"].items()} if isinstance(value["checks"], dict) else _compact_check(value["checks"])
    if "workflows" in value:
        result["workflows"] = value["workflows"]
    if "references" in value:
        result["references"] = value["references"]
    if "impact_slice" in value:
        result["impact_slice"] = value["impact_slice"]
    if isinstance(value.get("commands"), list):
        result["commands"] = [{key: item.get(key) for key in ("id", "command", "required", "reason") if item.get(key) is not None} for item in value["commands"][:max_findings] if isinstance(item, dict)]
        result["commands_count"] = len(value["commands"])
    for key in ("scenario_checks", "manual_or_live"):
        if isinstance(value.get(key), list):
            result[key] = value[key][:max_findings]
    if isinstance(value.get("entries"), list) and isinstance(value.get("invalidations"), list):
        valid_entries = [item for item in value["entries"] if isinstance(item, dict) and item.get("status") == "valid"]
        result["ledger"] = {"valid_entries": len(valid_entries), "invalid_entries": len(value["entries"]) - len(valid_entries), "reusable": [{"kind": item.get("kind"), "id": item.get("id"), "fingerprint": item.get("fingerprint")} for item in valid_entries[:max_findings]], "invalidations": value["invalidations"][-max_findings:]}
    if "frameworks" in value and "toolchain" in value:
        result["project"] = {"frameworks": value.get("frameworks", []), "test_files": len(value.get("tests", [])), "source": value.get("source", {}), "toolchain": value.get("toolchain", {}), "github": value.get("github", {})}
    for key in ("symbols", "module_edges", "candidate_flows", "files", "hits", "commits", "scenario_results", "mutation_results", "workflow_results"):
        if key in value:
            item = value[key]
            count = len(item) if hasattr(item, "__len__") else None
            result[f"{key}_count"] = count
            if isinstance(item, list):
                failed = [entry for entry in item if isinstance(entry, dict) and entry.get("passed") is False]
                if failed:
                    result[f"{key}_failures"] = failed[:max_findings]
                if key in {"hits", "commits"}:
                    result[key] = item[:max_findings]
    suites = {}
    for key, item in value.items():
        if isinstance(item, dict) and "passed" in item and isinstance(item.get("results"), list):
            failures = [entry for entry in item["results"] if isinstance(entry, dict) and entry.get("passed") is False]
            suites[key] = {"passed": item["passed"], "cases": len(item["results"]), "failures": failures[:max_findings]}
        elif key.endswith("_results") and isinstance(item, dict) and "passed" in item:
            suites[key] = {name: item[name] for name in ("passed", "checks", "metrics", "missing_anchors") if name in item}
    if suites:
        result["suite_summary"] = suites
    if len(result) == (2 if artifact_path else 1):
        keys = list(value)[:max_findings]
        result["fields"] = keys
        result["summary"] = {key: value[key] for key in keys if isinstance(value[key], (str, int, float, bool, type(None)))}
    return result


def compress_evidence(value: dict[str, Any]) -> dict[str, Any]:
    trace = []
    for item in value.get("traceability", []):
        if not isinstance(item, dict):
            continue
        trace.append({key: item.get(key) for key in ("requirement_id", "design_id", "path", "test_id", "evidence_id", "status") if item.get(key) is not None})
    checks = value.get("checks", {})
    compact_checks = {}
    for name, check in checks.items():
        if isinstance(check, dict) and isinstance(check.get("passed"), bool):
            compact_checks[name] = check["passed"]
        elif isinstance(check, bool):
            compact_checks[name] = check
        else:
            compact_checks[name] = None
    return {"version": 1, "passed": value.get("passed"), "claim": value.get("claim"), "checks": compact_checks, "trace": trace, "blockers": value.get("blockers", []), "unknowns": value.get("unknowns", []), "source_policy": "Keep the full evidence artifact; this receipt is an index, not a replacement."}
