from __future__ import annotations

import re
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .io_utils import read_text, relative
from .learning import redact_text
from .manifest import manifest


def _git(root: Path, *args: str) -> tuple[bool, str]:
    try:
        result = subprocess.run(
            ["git", *args], cwd=root, text=True, capture_output=True,
            timeout=20, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return False, str(error)
    value = result.stdout.rstrip() if result.returncode == 0 else result.stderr.strip()
    return result.returncode == 0, value


def _remote_slug(url: str) -> str | None:
    cleaned = re.sub(r"^[a-z]+://(?:[^/@]+@)?", "", url, flags=re.I)
    cleaned = re.sub(r"^git@github\.com:", "github.com/", cleaned)
    cleaned = cleaned.removesuffix(".git").strip("/")
    match = re.search(r"(?:^|/)github\.com/([^/]+/[^/]+)$", cleaned, re.I)
    return match.group(1) if match else None


def github_context(root: Path) -> dict[str, Any]:
    root = root.resolve()
    is_repo, top = _git(root, "rev-parse", "--show-toplevel")
    if not is_repo:
        return {"version": 1, "repository": None, "branch": None, "head_sha": None, "base_sha": None, "working_tree": {"available": False}, "workflows": [], "community_files": [], "unknowns": ["No local Git repository was found; resolve owner/repo through the GitHub connector."]}
    repo_root = Path(top)
    branch_ok, branch = _git(repo_root, "branch", "--show-current")
    head_ok, head = _git(repo_root, "rev-parse", "HEAD")
    upstream_ok, upstream = _git(repo_root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
    remote_ok, remote_url = _git(repo_root, "remote", "get-url", "origin")
    default_ok, default_ref = _git(repo_root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
    status_ok, status = _git(repo_root, "status", "--porcelain=v1")
    ahead = behind = None
    if upstream_ok:
        counts_ok, counts = _git(repo_root, "rev-list", "--left-right", "--count", f"{upstream}...HEAD")
        if counts_ok and len(counts.split()) == 2:
            behind, ahead = (int(value) for value in counts.split())
    workflows_root = repo_root / ".github" / "workflows"
    workflows = sorted(relative(repo_root, path) for path in workflows_root.glob("*") if path.is_file()) if workflows_root.is_dir() else []
    candidates = [
        ".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS",
        ".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md",
        ".github/dependabot.yml", ".github/dependabot.yaml", "SECURITY.md", ".github/SECURITY.md",
    ]
    community = [name for name in candidates if (repo_root / name).is_file()]
    issue_root = repo_root / ".github" / "ISSUE_TEMPLATE"
    if issue_root.is_dir():
        community.extend(relative(repo_root, path) for path in issue_root.iterdir() if path.is_file())
    changes = []
    if status_ok:
        for line in status.splitlines():
            if len(line) >= 3:
                changes.append({"status": line[:2], "path": line[3:]})
    unknowns = []
    if not remote_ok or not _remote_slug(remote_url):
        unknowns.append("The GitHub owner/repository could not be confirmed from origin.")
    if not upstream_ok:
        unknowns.append("The current branch has no confirmed upstream.")
    if not head_ok:
        unknowns.append("The local repository has no confirmed HEAD commit.")
    if not default_ok:
        unknowns.append("The remote default branch is not confirmed locally.")
    return {
        "version": 1,
        "root": str(repo_root),
        "repository": _remote_slug(remote_url) if remote_ok else None,
        "default_branch": default_ref.removeprefix("origin/") if default_ok else None,
        "branch": branch if branch_ok and branch else None,
        "head_sha": head if head_ok and head else None,
        "base_sha": None,
        "upstream": upstream if upstream_ok else None,
        "divergence": {"ahead": ahead, "behind": behind},
        "working_tree": {"available": status_ok, "clean": not changes, "changes": changes},
        "workflows": workflows,
        "community_files": sorted(set(community)),
        "unknowns": unknowns,
    }


def git_history(root: Path, *, path: str | None = None, limit: int = 10) -> dict[str, Any]:
    context = github_context(root)
    repo_root = Path(context.get("root") or root)
    args = ["log", f"-{max(1, min(limit, 100))}", "--date=iso-strict", "--pretty=format:%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s"]
    if path:
        args.extend(["--", path])
    ok, output = _git(repo_root, *args)
    commits = []
    if ok:
        for line in output.splitlines():
            parts = line.split("\x1f", 5)
            if len(parts) == 6:
                commits.append({"sha": parts[0], "parents": parts[1].split(), "author_name": parts[2], "author_email": parts[3], "date": parts[4], "subject": parts[5]})
    return {"version": 1, "repository": context.get("repository"), "branch": context.get("branch"), "path": path, "commits": commits, "available": ok, "limits": ["History indicates change provenance, not fault or intent by itself."]}


def _finding(severity: str, rule: str, path: str, line: int, message: str, confidence: str = "tentative") -> dict[str, Any]:
    return {"source": "github_actions", "severity": severity, "rule": rule, "path": path, "line": line, "message": message, "status": "open", "confidence": confidence}


def audit_workflows(root: Path) -> dict[str, Any]:
    repo = root.resolve()
    workflow_root = repo / ".github" / "workflows"
    findings: list[dict[str, Any]] = []
    files = sorted(path for path in workflow_root.glob("*") if path.suffix.lower() in {".yml", ".yaml"}) if workflow_root.is_dir() else []
    for path in files:
        text = read_text(path) or ""
        rel = relative(repo, path)
        lines = text.splitlines()
        if not re.search(r"(?m)^permissions\s*:", text) and not re.search(r"(?m)^\s+permissions\s*:", text):
            findings.append(_finding("medium", "missing_permissions", rel, 1, "No explicit GITHUB_TOKEN permissions block was found; confirm effective least privilege."))
        for index, line in enumerate(lines, start=1):
            if re.search(r"permissions\s*:\s*write-all", line):
                findings.append(_finding("critical", "write_all_permissions", rel, index, "Workflow grants write-all token permissions.", "confirmed"))
            match = re.search(r"\buses\s*:\s*([^\s#]+)@([^\s#]+)", line)
            if match and not match.group(1).startswith("./") and not re.fullmatch(r"[0-9a-fA-F]{40}", match.group(2)):
                findings.append(_finding("low", "mutable_action_ref", rel, index, f"Action {match.group(1)} uses a mutable/non-SHA ref; apply repository provenance policy."))
            if "${{" in line and re.search(r"github\.event\.(?:issue|pull_request|comment)|github\.head_ref|inputs\.", line) and re.search(r"run\s*:|\becho\b|\bsh\b|\bbash\b", line):
                findings.append(_finding("high", "untrusted_expression_in_shell", rel, index, "Potentially untrusted GitHub expression appears in a shell boundary; pass validated data through environment/input handling."))
        if "pull_request_target:" in text and re.search(r"uses\s*:\s*actions/checkout", text):
            findings.append(_finding("critical", "pr_target_checkout", rel, text.count("\n", 0, text.find("pull_request_target:")) + 1, "pull_request_target is combined with checkout; confirm untrusted PR code is never executed.", "strong_inference"))
        if re.search(r"(?m)^\s*pull_request\s*:", text) and "merge_group:" not in text:
            findings.append(_finding("info", "merge_group_unknown", rel, 1, "Workflow has pull_request but no merge_group trigger; required only when this repository uses merge queue."))
        if "concurrency:" not in text:
            findings.append(_finding("info", "concurrency_absent", rel, 1, "No concurrency policy found; decide whether stale runs or overlapping deployments need cancellation/serialization."))
        if "timeout-minutes:" not in text:
            findings.append(_finding("low", "timeout_absent", rel, 1, "No timeout-minutes was found; confirm jobs cannot hang indefinitely."))
        if re.search(r"(?m)^\s*(?:paths|paths-ignore)\s*:", text):
            findings.append(_finding("info", "path_filter_required_check", rel, 1, "Path filters can leave a required check unreported; compare with branch rules."))
    findings.sort(key=lambda item: ({"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}[item["severity"]], item["path"], item["line"], item["rule"]))
    return {"version": 1, "scanned_workflows": len(files), "findings": findings, "limits": ["Line-oriented audit; confirm YAML structure, repository settings, effective permissions, and fork behavior in context."]}


def normalize_findings(value: Any, source: str) -> dict[str, Any]:
    source_contract = manifest("github-check-sources.json").get("sources", {}).get(source)
    if isinstance(value, dict) and isinstance(value.get("runs"), list):
        raw = []
        for run in value["runs"]:
            for result in run.get("results", []):
                location = ((result.get("locations") or [{}])[0].get("physicalLocation") or {})
                artifact = location.get("artifactLocation") or {}
                region = location.get("region") or {}
                message = result.get("message") or {}
                raw.append({"rule": result.get("ruleId"), "level": result.get("level"), "message": message.get("text") or message.get("markdown"), "path": artifact.get("uri"), "line": region.get("startLine")})
    elif isinstance(value, dict):
        raw = value.get("findings") or value.get("issues") or value.get("results") or value.get("annotations") or []
    else:
        raw = value
    if not isinstance(raw, list):
        raise ValueError("input must be an array or contain findings/issues/results/annotations")
    severity_map = {"error": "high", "warning": "medium", "warn": "medium", "minor": "low", "major": "high", "blocker": "critical", "critical": "critical", "info": "info", "note": "info"}
    normalized = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            continue
        severity_raw = str(item.get("severity") or item.get("level") or item.get("type") or "unknown").lower()
        message = str(item.get("message") or item.get("description") or item.get("title") or "Unspecified finding")
        path = item.get("path") or item.get("file") or item.get("filename") or item.get("filePath") or item.get("component")
        text_range = item.get("textRange") if isinstance(item.get("textRange"), dict) else {}
        line = item.get("line") or item.get("start_line") or item.get("lineNumber") or text_range.get("startLine")
        try:
            line = int(line) if line is not None else None
        except (TypeError, ValueError):
            line = None
        rule = str(item.get("rule") or item.get("rule_id") or item.get("key") or item.get("code") or f"unmapped-{index + 1}")
        normalized.append({"source": source, "rule": rule, "severity": severity_map.get(severity_raw, severity_raw if severity_raw in {"critical", "high", "medium", "low", "info"} else "unknown"), "path": str(path) if path else None, "line": line, "message": message, "status": str(item.get("status") or "open"), "confidence": str(item.get("confidence") or "tentative")})
    seen: set[tuple[Any, ...]] = set()
    unique = []
    for item in normalized:
        key = (item["source"], item["rule"], item["path"], item["line"], re.sub(r"\s+", " ", item["message"].lower()).strip())
        if key not in seen:
            seen.add(key)
            unique.append(item)
    return {"version": 1, "source": source, "source_contract": source_contract, "source_known": source_contract is not None, "input_count": len(raw), "findings": unique, "duplicates_removed": len(normalized) - len(unique)}


def triage_ci_log(text: str, source: str = "github_actions") -> dict[str, Any]:
    redacted = redact_text(text)
    patterns = [
        ("permission", re.compile(r"permission denied|resource not accessible by integration|http\s*403", re.I)),
        ("missing_configuration", re.compile(r"(?:missing|required|undefined).{0,40}(?:secret|environment|env\b|variable|configuration)", re.I)),
        ("dependency", re.compile(r"cannot find module|module not found|no matching distribution|dependency.*failed", re.I)),
        ("test", re.compile(r"(?:test|tests|suite).{0,40}(?:failed|failure)|assertionerror|expected .+ (?:to|but)", re.I)),
        ("type_or_lint", re.compile(r"typescript error|\berror ts\d+|eslint|ruff|flake8|lint(?:ing)? failed", re.I)),
        ("timeout", re.compile(r"timed? out|timeout|exceeded.*minutes", re.I)),
        ("rate_limit", re.compile(r"rate limit|http\s*429|too many requests", re.I)),
        ("runner_or_provider", re.compile(r"runner.*lost|service unavailable|http\s*5\d\d|network.*(?:reset|unreachable)", re.I)),
    ]
    candidates = []
    for number, line in enumerate(redacted.splitlines(), start=1):
        if not line.strip():
            continue
        for category, pattern in patterns:
            if pattern.search(line):
                candidates.append({"line": number, "category": category, "text": line.strip()[:500]})
                break
    first = candidates[0] if candidates else None
    return {"version": 1, "source": source, "classification": first["category"] if first else "unknown", "first_causal_candidate": first, "other_candidates": candidates[1:20], "confidence": "tentative", "next_checks": ["bind log to workflow/job/step/attempt/head SHA", "inspect context before the first candidate", "reproduce with repository-native command when feasible", "separate cascading failures and rerun only when flakiness/infrastructure is plausible"], "limits": ["Pattern triage cannot prove root cause; inspect the full structured run and current diff."]}


def pull_request_contract(request: str, root: Path, base: str | None = None) -> dict[str, Any]:
    context = github_context(root)
    changed: list[str] = []
    base_sha = None
    if base:
        ok, merge_base = _git(Path(context.get("root") or root), "merge-base", base, "HEAD")
        if ok:
            base_sha = merge_base
            names_ok, names = _git(Path(context["root"]), "diff", "--name-only", f"{merge_base}...HEAD")
            changed = names.splitlines() if names_ok and names else []
    risk = "medium"
    lowered = " ".join(changed).lower() + " " + request.lower()
    risk_signals = manifest("github-risk.json")["signals"]
    aliases = {
        "critical": ["oauth", "economy", "monetization", "migration", "deploy", "release", "write token"],
        "high": [".github/workflows", "permission", "moderation", "dependabot", "codeql", "ruleset"],
    }
    matched_risk_signals = {
        level: [signal for signal in signals if signal.replace("_", " ") in lowered]
        for level, signals in risk_signals.items()
    }
    if matched_risk_signals["critical"] or any(term in lowered for term in aliases["critical"]):
        risk = "critical"
    elif matched_risk_signals["high"] or any(term in lowered for term in aliases["high"]):
        risk = "high"
    return {"version": 1, "goal": request, "repository": context["repository"], "base": base, "base_sha": base_sha, "head": context["branch"], "head_sha": context["head_sha"], "scope": changed, "risk": risk, "risk_signals": matched_risk_signals, "discord_surfaces": [], "permissions_intents_scopes": [], "state_persistence": [], "failure_concurrency": [], "ux_states": [], "verification": ["focused_behavior", "repository_native_static_check", "current_sha_required_checks", "diff_review"], "configuration_migration": [], "security": [], "rollback": [], "tool_routing": manifest("github-tool-routing.json")["routes"], "unknowns": context["unknowns"] + (["Base/merge-base diff is not confirmed."] if not base_sha else []), "status": "draft_requires_evidence"}


def github_evidence(root: Path, *, pr: Any = None, checks: Any = None, reviews: Any = None, findings: Any = None, local: Any = None) -> dict[str, Any]:
    context = github_context(root)
    unknowns = list(context["unknowns"])
    if checks is None:
        unknowns.append("Remote checks were not supplied from GitHub.")
    if reviews is None:
        unknowns.append("Current review/thread state was not supplied from GitHub.")
    check_items = checks.get("checks", []) if isinstance(checks, dict) else checks
    finding_items = findings.get("findings", []) if isinstance(findings, dict) else findings
    return {"version": 1, "created_at": datetime.now(timezone.utc).isoformat(), "repository": context["repository"], "branch": context["branch"], "head_sha": context["head_sha"], "pull_request": pr, "checks": check_items if isinstance(check_items, list) else [], "reviews": reviews if isinstance(reviews, dict) else {"decision": "unknown", "unresolved_blocking": None}, "local": local if isinstance(local, dict) else {"tests": {"passed": False}, "diff_review": False, "security": False}, "findings": finding_items if isinstance(finding_items, list) else [], "unknowns": unknowns, "claim": "github_evidence_not_absolute_proof"}


def github_gate(evidence: dict[str, Any]) -> dict[str, Any]:
    checks = evidence.get("checks", [])
    required = [item for item in checks if item.get("required") is True]
    required_ok = bool(required) and all(item.get("head_sha") == evidence.get("head_sha") and item.get("conclusion") == "success" for item in required)
    reviews = evidence.get("reviews", {})
    local = evidence.get("local", {})
    blocking_findings = [
        item for item in evidence.get("findings", [])
        if isinstance(item, dict)
        and str(item.get("severity", "")).lower() in {"critical", "high"}
        and str(item.get("status", "open")).lower() not in {"resolved", "dismissed", "fixed", "accepted"}
    ]
    gates = {
        "repository_resolved": bool(evidence.get("repository")),
        "base_head_sha": bool(evidence.get("head_sha") and evidence.get("pull_request", {}).get("base_sha") if isinstance(evidence.get("pull_request"), dict) else False),
        "requirements": bool(evidence.get("pull_request", {}).get("goal") if isinstance(evidence.get("pull_request"), dict) else False),
        "diff_review": local.get("diff_review") is True,
        "tests": bool(local.get("tests", {}).get("passed")) if isinstance(local.get("tests"), dict) else local.get("tests") is True,
        "security": local.get("security") is True and not blocking_findings,
        "required_checks": required_ok,
        "reviews_resolved": reviews.get("unresolved_blocking") == 0 and reviews.get("decision") not in {"changes_requested", "unknown"},
        "mergeable": evidence.get("pull_request", {}).get("mergeable") is True if isinstance(evidence.get("pull_request"), dict) else False,
        "unknowns_clear": "unknowns" in evidence and not evidence.get("unknowns"),
    }
    pull_request = evidence.get("pull_request") if isinstance(evidence.get("pull_request"), dict) else {}
    if pull_request.get("merged") is True:
        live = evidence.get("deployment", {}).get("live_discord_verified") if isinstance(evidence.get("deployment"), dict) else False
        production_gates = ("repository_resolved", "base_head_sha", "requirements", "diff_review", "tests", "security", "required_checks", "unknowns_clear")
        production_verified = live is True and all(gates.get(name) is True for name in production_gates)
        state = "merged_verified_in_production" if production_verified else "merged_unverified_in_production"
    elif reviews.get("decision") == "changes_requested" or (reviews.get("unresolved_blocking") or 0) > 0:
        state = "changes_requested"
    elif any(item.get("required") and item.get("conclusion") == "failure" for item in checks):
        state = "ci_failed"
    elif evidence.get("configuration_blocked") is True:
        state = "blocked_by_configuration"
    elif all(gates.get(name) is True for name in manifest("github-gates.json")["ready_to_merge"]):
        state = "ready_to_merge"
    elif (bool(local.get("tests", {}).get("passed")) if isinstance(local.get("tests"), dict) else local.get("tests") is True):
        state = "ready_for_review"
    else:
        state = "implemented_but_unverified"
    return {"passed": state in {"ready_to_merge", "merged_verified_in_production"}, "state": state, "gates": gates, "blocking_findings": blocking_findings}


def release_plan(root: Path, version: str | None = None, previous_tag: str | None = None) -> dict[str, Any]:
    context = github_context(root)
    target = {"version": version, "tag": f"v{version}" if version and not version.startswith("v") else version, "head_sha": context["head_sha"], "previous_tag": previous_tag}
    unknowns = list(context["unknowns"])
    if not version:
        unknowns.append("Release version/source has not been selected.")
    if not previous_tag:
        unknowns.append("Previous authoritative release tag has not been supplied.")
    return {"version": 1, "repository": context["repository"], "target": target, "authority": "draft_only_until_explicit_publish_authority", "checks": ["release_diff", "tests_and_build", "current_sha_ci", "security", "dependencies", "configuration", "migrations", "discord_command_registration", "artifact_provenance", "deployment_readiness"], "release_notes": {"breaking": [], "features": [], "fixes": [], "security": [], "operations": []}, "rollout": ["draft_release", "approval", "staged_deployment", "health_checks", "discord_smoke_test"], "rollback": ["preserve_previous_artifact", "define_data_compatibility", "revert_or_forward_fix", "verify_recovery"], "unknowns": unknowns, "status": "draft_requires_evidence" if unknowns else "ready_for_draft_release"}


def evaluate_github_cases(cases: dict[str, Any]) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    for case in cases.get("workflow_cases", []):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workflow = root / ".github" / "workflows" / "fixture.yml"
            workflow.parent.mkdir(parents=True)
            workflow.write_text(str(case.get("workflow", "")), encoding="utf-8")
            found = {item["rule"] for item in audit_workflows(root)["findings"]}
        missing = sorted(set(case.get("must_find", [])) - found)
        forbidden = sorted(set(case.get("must_not_find", [])) & found)
        results.append({"id": case.get("id"), "passed": not missing and not forbidden, "missing": missing, "forbidden": forbidden, "found": sorted(found)})

    head = "a" * 40
    base_pr = {"goal": "fixture", "base_sha": "b" * 40, "mergeable": True}
    current_check = {"name": "test", "required": True, "head_sha": head, "conclusion": "success"}
    base_evidence = {"repository": "example/bot", "head_sha": head, "pull_request": base_pr, "checks": [current_check], "reviews": {"decision": "approved", "unresolved_blocking": 0}, "local": {"tests": {"passed": True}, "diff_review": True, "security": True}, "unknowns": []}
    for case in cases.get("gate_cases", []):
        evidence = {**base_evidence, "checks": [dict(current_check)], "reviews": dict(base_evidence["reviews"]), "local": {**base_evidence["local"], "tests": dict(base_evidence["local"]["tests"])}}
        mutation = case.get("mutation")
        if mutation == "required_check_sha_differs":
            evidence["checks"][0]["head_sha"] = "c" * 40
        elif mutation == "blocking_review":
            evidence["reviews"] = {"decision": "changes_requested", "unresolved_blocking": 1}
        result = github_gate(evidence)
        results.append({"id": case.get("id"), "passed": result["state"] == case.get("expected_state"), "expected": case.get("expected_state"), "actual": result["state"]})
    return {"passed": all(item["passed"] for item in results), "results": results}
