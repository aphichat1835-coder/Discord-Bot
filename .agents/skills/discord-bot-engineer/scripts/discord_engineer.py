#!/usr/bin/env python3
"""Unified evidence-oriented workflow for Discord bot engineering."""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path
from typing import Any

from discord_engineer_lib.analyzers import analyze_project
from discord_engineer_lib.compact import compact_result, compress_evidence
from discord_engineer_lib.context_ledger import infer_fingerprint, invalidate_entry, ledger_summary, new_ledger, record_entry
from discord_engineer_lib.contracts import completion_gate, make_feature_contract
from discord_engineer_lib.defects import defect_gate, make_defect_contract, scan_neighborhood
from discord_engineer_lib.domains import DOMAIN_PROFILES, analyze_domain, domain_gate, make_domain_contract
from discord_engineer_lib.evidence import receipt
from discord_engineer_lib.github import (
    audit_workflows,
    evaluate_github_cases,
    git_history,
    github_context,
    github_evidence,
    github_gate,
    normalize_findings,
    pull_request_contract,
    release_plan,
    triage_ci_log,
)
from discord_engineer_lib.io_utils import dump_json, load_json
from discord_engineer_lib.learning import compare_artifacts, evaluate_artifact, regression_proposal
from discord_engineer_lib.learning import redact_text
from discord_engineer_lib.manifest import route_request, validate_manifests
from discord_engineer_lib.project_model import build_project_model
from discord_engineer_lib.scenarios import run_scenario
from discord_engineer_lib.schema_validation import available_schemas, validate_named
from discord_engineer_lib.sdlc import make_sdlc_plan, sdlc_gate
from discord_engineer_lib.ux import audit_experience, compile_discord_payload, compile_ux, decide_ux, experience_gate, validate_ux
from discord_engineer_lib.semantic import build_semantic_index, impact_slice
from discord_engineer_lib.proof import production_proof_gate
from discord_engineer_lib.token_budget import evaluate_budget_cases, evaluate_skill_efficiency, make_token_budget
from discord_engineer_lib.verification import make_verification_plan
from discord_engineer_lib.visual import compare_visual_plans, compose_components_v2, make_visual_plan

HERE = Path(__file__).resolve().parent
SKILL_ROOT = HERE.parent


def emit(value: Any, output: str | None = None, *, compact: bool = False, max_findings: int = 8, only_blockers: bool = False) -> None:
    rendered = dump_json(value)
    if output:
        Path(output).write_text(rendered + "\n", encoding="utf-8")
    shown = compact_result(value, max_findings=max_findings, only_blockers=only_blockers, artifact_path=output) if compact else value
    print(dump_json(shown))


def emit_validated(value: dict[str, Any], schema_name: str, output: str | None = None, *, compact: bool = False, max_findings: int = 8, only_blockers: bool = False) -> bool:
    errors = validate_named(value, schema_name)
    if errors:
        value = {**value, "_schema_errors": errors}
    emit(value, output, compact=compact, max_findings=max_findings, only_blockers=only_blockers)
    return not errors


def root_path(value: str) -> Path:
    path = Path(value).expanduser().resolve()
    if not path.is_dir():
        raise argparse.ArgumentTypeError(f"not a directory: {path}")
    return path


def add_view_args(parser: argparse.ArgumentParser) -> None:
    view = parser.add_mutually_exclusive_group()
    view.add_argument("--compact", action="store_true", help="print the default compact context view")
    view.add_argument("--full", action="store_true", help="print the full artifact instead of the compact context view")
    parser.add_argument("--max-findings", type=int, default=8)
    parser.add_argument("--only-blockers", action="store_true")


def view_args(args: argparse.Namespace) -> dict[str, Any]:
    return {"compact": not getattr(args, "full", False), "max_findings": max(1, getattr(args, "max_findings", 8)), "only_blockers": getattr(args, "only_blockers", False)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    inspect = sub.add_parser("inspect", help="build the central Project Model")
    inspect.add_argument("root", nargs="?", default=".", type=root_path)
    inspect.add_argument("--max-files", type=int, default=4000)
    inspect.add_argument("--output")
    add_view_args(inspect)

    route = sub.add_parser("route", help="select profiles, analyzers, and references")
    route.add_argument("request")
    route.add_argument("--root", type=root_path)

    budget = sub.add_parser("budget", help="plan context, references, tools, and output depth without limiting required proof")
    budget.add_argument("request")
    budget.add_argument("--root", type=root_path)
    budget.add_argument("--output")

    audit = sub.add_parser("audit", help="run semantic/structural review leads")
    audit.add_argument("root", nargs="?", default=".", type=root_path)
    audit.add_argument("--kind", action="append", choices=["security", "interaction", "authorization", "lifecycle", "impact"])
    audit.add_argument("--strict", action="store_true")
    audit.add_argument("--output")
    add_view_args(audit)

    for name in ("interactions", "permissions", "lifecycle", "impact"):
        item = sub.add_parser(name, help=f"run the {name} analysis profile")
        item.add_argument("root", nargs="?", default=".", type=root_path)
        item.add_argument("--output")
        add_view_args(item)

    contract = sub.add_parser("contract", help="create a draft Feature Contract")
    contract.add_argument("request")
    contract.add_argument("--root", type=root_path)
    contract.add_argument("--output")

    sdlc = sub.add_parser("sdlc", help="plan or gate a risk-scaled software lifecycle")
    sdlc_sub = sdlc.add_subparsers(dest="sdlc_command", required=True)
    sdlc_plan = sdlc_sub.add_parser("plan")
    sdlc_plan.add_argument("request")
    sdlc_plan.add_argument("--contract", type=Path)
    sdlc_plan.add_argument("--output")
    sdlc_ready = sdlc_sub.add_parser("gate")
    sdlc_ready.add_argument("plan", type=Path)
    sdlc_ready.add_argument("evidence", type=Path)

    defect = sub.add_parser("defect", help="close a defect through reproduction, root cause, neighborhood, regression, and counterexamples")
    defect_sub = defect.add_subparsers(dest="defect_command", required=True)
    defect_contract = defect_sub.add_parser("contract")
    defect_contract.add_argument("request")
    defect_contract.add_argument("--risk", choices=["low", "medium", "high", "critical"], default="medium")
    defect_contract.add_argument("--output")
    defect_neighborhood = defect_sub.add_parser("neighborhood")
    defect_neighborhood.add_argument("root", nargs="?", default=".", type=root_path)
    defect_neighborhood.add_argument("--symbol", action="append", required=True)
    defect_neighborhood.add_argument("--output")
    add_view_args(defect_neighborhood)
    defect_ready = defect_sub.add_parser("gate")
    defect_ready.add_argument("contract", type=Path)
    defect_ready.add_argument("evidence", type=Path)

    domain = sub.add_parser("domain", help="plan or gate Discord domain-specific invariants and scenarios")
    domain_sub = domain.add_subparsers(dest="domain_command", required=True)
    domain_plan = domain_sub.add_parser("plan")
    domain_plan.add_argument("request")
    domain_plan.add_argument("--profile", required=True, choices=sorted(DOMAIN_PROFILES))
    domain_plan.add_argument("--output")
    domain_ready = domain_sub.add_parser("gate")
    domain_ready.add_argument("contract", type=Path)
    domain_ready.add_argument("evidence", type=Path)
    domain_analyze = domain_sub.add_parser("analyze", help="collect static review leads for domain invariants")
    domain_analyze.add_argument("root", nargs="?", default=".", type=root_path)
    domain_analyze.add_argument("--profile", required=True, choices=sorted(DOMAIN_PROFILES))
    domain_analyze.add_argument("--output")
    add_view_args(domain_analyze)

    semantic = sub.add_parser("semantic", help="build a bounded cross-file semantic and candidate-flow index")
    semantic.add_argument("root", nargs="?", default=".", type=root_path)
    semantic.add_argument("--changed", action="append")
    semantic.add_argument("--depth", type=int, default=3)
    semantic.add_argument("--output")
    add_view_args(semantic)

    ux = sub.add_parser("ux", help="decide or validate Discord/dashboard experience")
    ux_sub = ux.add_subparsers(dest="ux_command", required=True)
    decide = ux_sub.add_parser("decide")
    decide.add_argument("purpose")
    decide.add_argument("--surface", required=True, choices=["plain", "embed", "legacy_components", "components_v2", "modal", "ephemeral", "dashboard"])
    decide.add_argument("--duration-ms", type=int)
    decide.add_argument("--total-known", action="store_true")
    decide.add_argument("--new-user", action="store_true")
    decide.add_argument("--destructive", action="store_true")
    decide.add_argument("--output")
    ux_validate = ux_sub.add_parser("validate")
    ux_validate.add_argument("decision", type=Path)
    ux_compile = ux_sub.add_parser("compile")
    ux_compile.add_argument("decision", type=Path)
    ux_compile.add_argument("--framework", required=True, choices=["discord.js", "discord.py", "dashboard"])
    ux_compile.add_argument("--output")
    ux_payload = ux_sub.add_parser("payload", help="compile a concrete Discord REST-shaped payload for review")
    ux_payload.add_argument("decision", type=Path)
    ux_payload.add_argument("--summary", required=True)
    ux_payload.add_argument("--detail")
    ux_payload.add_argument("--state", default="working")
    ux_payload.add_argument("--custom-id")
    ux_payload.add_argument("--button-label", default="Cancel")
    ux_payload.add_argument("--output")
    ux_audit = ux_sub.add_parser("audit")
    ux_audit.add_argument("root", nargs="?", default=".", type=root_path)
    ux_audit.add_argument("--output")
    add_view_args(ux_audit)
    ux_gate = ux_sub.add_parser("gate")
    ux_gate.add_argument("review", type=Path)
    ux_plan = ux_sub.add_parser("plan", help="select a context-aware panel, direction, composition, copy, and proof contract")
    ux_plan.add_argument("purpose")
    ux_plan.add_argument("--command-type", choices=["information", "moderation", "setup", "music", "economy", "security", "ticket", "generic"], default="generic")
    ux_plan.add_argument("--surface", choices=["components_v2", "modal", "dashboard"], default="components_v2")
    ux_plan.add_argument("--direction", default="auto")
    ux_plan.add_argument("--panel", default="auto")
    ux_plan.add_argument("--density", choices=["compact", "balanced", "comfortable", "spacious"], default="balanced")
    ux_plan.add_argument("--brand-intensity", choices=["low", "medium", "high"], default="medium")
    ux_plan.add_argument("--taste", type=Path)
    ux_plan.add_argument("--output")
    ux_compose = ux_sub.add_parser("compose", help="validate and compose a Discord Components V2 message payload")
    ux_compose.add_argument("spec", type=Path)
    ux_compose.add_argument("--output")
    ux_compare = ux_sub.add_parser("compare", help="compare visual plans and reject structurally duplicated variants")
    ux_compare.add_argument("plans", nargs="+", type=Path)
    ux_compare.add_argument("--output")

    scenario = sub.add_parser("scenario", help="execute a deterministic abstract state scenario")
    scenario.add_argument("scenario", type=Path)

    verify = sub.add_parser("verify", help="run project checks and issue an evidence receipt")
    verify.add_argument("root", nargs="?", default=".", type=root_path)
    verify.add_argument("--risk", choices=["low", "medium", "high", "critical"], default="medium")
    verify.add_argument("--profile", action="append")
    verify.add_argument("--strict", action="store_true")
    verify.add_argument("--output")
    add_view_args(verify)

    verify_plan = sub.add_parser("verification-plan", help="select repository-native commands and risk scenarios without running them")
    verify_plan.add_argument("root", nargs="?", default=".", type=root_path)
    verify_plan.add_argument("--risk", choices=["low", "medium", "high", "critical"], default="medium")
    verify_plan.add_argument("--profile", action="append")
    verify_plan.add_argument("--output")
    add_view_args(verify_plan)

    schema = sub.add_parser("schema", help="validate a JSON artifact against a bundled runtime schema")
    schema_sub = schema.add_subparsers(dest="schema_command", required=True)
    schema_validate = schema_sub.add_parser("validate")
    schema_validate.add_argument("schema_name", choices=available_schemas())
    schema_validate.add_argument("document", type=Path)

    learn = sub.add_parser("learn", help="sanitize a real failure and propose a reviewed regression case")
    learn.add_argument("incident", type=Path)
    learn.add_argument("--output")

    eval_artifact = sub.add_parser("eval-artifact", help="score declared evidence coverage for one benchmark case")
    eval_artifact.add_argument("case", type=Path)
    eval_artifact.add_argument("artifact", type=Path)

    compare = sub.add_parser("compare-artifacts", help="compare independently reviewed baseline and Skill-assisted artifacts")
    compare.add_argument("case", type=Path)
    compare.add_argument("baseline", type=Path)
    compare.add_argument("candidate", type=Path)

    proof = sub.add_parser("proof", help="gate deterministic, repository, experience, or live evidence without claim inflation")
    proof.add_argument("evidence", type=Path)
    proof.add_argument("--target", choices=["deterministic_verified", "repository_verified", "experience_verified", "live_verified"], default="repository_verified")

    evidence = sub.add_parser("evidence", help="compress a full evidence artifact into a traceable context receipt")
    evidence_sub = evidence.add_subparsers(dest="evidence_command", required=True)
    evidence_compact = evidence_sub.add_parser("compact")
    evidence_compact.add_argument("document", type=Path)
    evidence_compact.add_argument("--output")

    ledger = sub.add_parser("ledger", help="track reusable context and invalidate stale evidence")
    ledger_sub = ledger.add_subparsers(dest="ledger_command", required=True)
    ledger_init = ledger_sub.add_parser("init")
    ledger_init.add_argument("request")
    ledger_init.add_argument("--root", default=".", type=root_path)
    ledger_init.add_argument("--output", required=True)
    ledger_record = ledger_sub.add_parser("record")
    ledger_record.add_argument("ledger", type=Path)
    ledger_record.add_argument("--kind", required=True, choices=["reference", "file", "command", "evidence", "repository"])
    ledger_record.add_argument("--id", required=True)
    ledger_record.add_argument("--fingerprint")
    ledger_record.add_argument("--output")
    ledger_invalidate = ledger_sub.add_parser("invalidate")
    ledger_invalidate.add_argument("ledger", type=Path)
    ledger_invalidate.add_argument("--id", required=True)
    ledger_invalidate.add_argument("--reason", required=True)
    ledger_invalidate.add_argument("--output")
    ledger_show = ledger_sub.add_parser("summary")
    ledger_show.add_argument("ledger", type=Path)

    gate = sub.add_parser("gate", help="evaluate the Completion Gate")
    gate.add_argument("contract", type=Path)
    gate.add_argument("receipt", type=Path)

    github = sub.add_parser("github", help="run the GitHub-first repository workflow")
    github_sub = github.add_subparsers(dest="github_command", required=True)
    github_inspect = github_sub.add_parser("inspect", help="resolve local GitHub repository context")
    github_inspect.add_argument("root", nargs="?", default=".", type=root_path)
    github_inspect.add_argument("--output")
    github_history = github_sub.add_parser("history", help="inspect bounded commit history for a repository or path")
    github_history.add_argument("root", nargs="?", default=".", type=root_path)
    github_history.add_argument("--path")
    github_history.add_argument("--limit", type=int, default=10)
    github_history.add_argument("--output")
    add_view_args(github_history)
    workflow_audit = github_sub.add_parser("workflow-audit", help="review GitHub Actions workflow security and reliability")
    workflow_audit.add_argument("root", nargs="?", default=".", type=root_path)
    workflow_audit.add_argument("--strict", action="store_true")
    workflow_audit.add_argument("--output")
    add_view_args(workflow_audit)
    normalize = github_sub.add_parser("normalize", help="normalize provider quality/CI findings")
    normalize.add_argument("input", type=Path)
    normalize.add_argument("--source", required=True)
    normalize.add_argument("--output")
    add_view_args(normalize)
    log_triage = github_sub.add_parser("log-triage", help="classify the first likely causal CI log line")
    log_triage.add_argument("log", type=Path)
    log_triage.add_argument("--source", default="github_actions")
    log_triage.add_argument("--output")
    github_contract = github_sub.add_parser("contract", help="create a GitHub pull-request contract")
    github_contract.add_argument("request")
    github_contract.add_argument("--root", default=".", type=root_path)
    github_contract.add_argument("--base")
    github_contract.add_argument("--output")
    github_receipt = github_sub.add_parser("evidence", help="combine local and remote GitHub evidence")
    github_receipt.add_argument("--root", default=".", type=root_path)
    github_receipt.add_argument("--pr", type=Path)
    github_receipt.add_argument("--checks", type=Path)
    github_receipt.add_argument("--reviews", type=Path)
    github_receipt.add_argument("--findings", type=Path)
    github_receipt.add_argument("--local", type=Path)
    github_receipt.add_argument("--output")
    add_view_args(github_receipt)
    github_ready = github_sub.add_parser("gate", help="evaluate GitHub PR readiness")
    github_ready.add_argument("evidence", type=Path)
    github_release = github_sub.add_parser("release-plan", help="prepare a non-publishing release plan")
    github_release.add_argument("--root", default=".", type=root_path)
    github_release.add_argument("--version")
    github_release.add_argument("--previous-tag")
    github_release.add_argument("--output")

    evaluate = sub.add_parser("eval", help="validate manifests and deterministic evaluation cases")
    evaluate.add_argument("--strict", action="store_true")
    evaluate.add_argument("--output")
    add_view_args(evaluate)

    args = parser.parse_args()
    if args.command == "inspect":
        return 0 if emit_validated(build_project_model(args.root, args.max_files), "project-model.schema.json", args.output, **view_args(args)) else 1
    if args.command == "route":
        model = build_project_model(args.root) if args.root else None
        stack = {"framework": " ".join(item["family"] for item in model["frameworks"])} if model else None
        emit(route_request(args.request, stack))
        return 0
    if args.command == "budget":
        model = build_project_model(args.root) if args.root else None
        stack = {"framework": " ".join(item["family"] for item in model["frameworks"])} if model else None
        return 0 if emit_validated(make_token_budget(args.request, stack), "token-budget.schema.json", args.output) else 1
    if args.command in {"audit", "interactions", "permissions", "lifecycle", "impact"}:
        mapping = {"interactions": "interaction", "permissions": "authorization", "lifecycle": "lifecycle", "impact": "impact"}
        kinds = set(args.kind) if args.command == "audit" and args.kind else ({mapping[args.command]} if args.command != "audit" else None)
        result = analyze_project(args.root, kinds)
        emit(result, args.output, **view_args(args))
        serious = any(item["severity"] == "error" or (getattr(args, "strict", False) and item["severity"] == "warning") for item in result["findings"])
        return 1 if serious else 0
    if args.command == "contract":
        model = build_project_model(args.root) if args.root else None
        stack = {"framework": " ".join(item["family"] for item in model["frameworks"])} if model else None
        return 0 if emit_validated(make_feature_contract(args.request, args.root, stack), "feature-contract.schema.json", args.output) else 1
    if args.command == "sdlc":
        if args.sdlc_command == "plan":
            contract_value = load_json(args.contract) if args.contract else None
            return 0 if emit_validated(make_sdlc_plan(args.request, contract_value), "sdlc-plan.schema.json", args.output) else 1
        result = sdlc_gate(load_json(args.plan), load_json(args.evidence))
        emit(result)
        return 0 if result["passed"] else 1
    if args.command == "defect":
        if args.defect_command == "contract":
            return 0 if emit_validated(make_defect_contract(args.request, args.risk), "defect-contract.schema.json", args.output) else 1
        if args.defect_command == "neighborhood":
            emit(scan_neighborhood(args.root, args.symbol), args.output, **view_args(args))
            return 0
        result = defect_gate(load_json(args.contract), load_json(args.evidence))
        emit(result)
        return 0 if result["passed"] else 1
    if args.command == "domain":
        if args.domain_command == "plan":
            return 0 if emit_validated(make_domain_contract(args.profile, args.request), "domain-contract.schema.json", args.output) else 1
        if args.domain_command == "analyze":
            emit(analyze_domain(args.root, args.profile), args.output, **view_args(args))
            return 0
        result = domain_gate(load_json(args.contract), load_json(args.evidence))
        emit(result)
        return 0 if result["passed"] else 1
    if args.command == "ux":
        if args.ux_command == "plan":
            value = make_visual_plan(purpose=args.purpose, command_type=args.command_type, surface=args.surface, direction=args.direction, panel=args.panel, density=args.density, brand_intensity=args.brand_intensity, taste=load_json(args.taste) if args.taste else None)
            return 0 if emit_validated(value, "visual-experience-plan.schema.json", args.output) else 1
        if args.ux_command == "compose":
            value = compose_components_v2(load_json(args.spec))
            emit(value, args.output)
            return 0 if value["valid"] else 1
        if args.ux_command == "compare":
            value = compare_visual_plans([load_json(path) for path in args.plans])
            emit(value, args.output)
            return 0 if value["passed"] else 1
        if args.ux_command == "decide":
            return 0 if emit_validated(decide_ux(surface=args.surface, purpose=args.purpose.lower(), duration_ms=args.duration_ms, total_known=args.total_known, new_user=args.new_user, destructive=args.destructive), "ux-decision.schema.json", args.output) else 1
        if args.ux_command == "validate":
            decision = load_json(args.decision)
            findings = validate_ux(decision)
            emit({"passed": not any(item["level"] == "error" for item in findings), "findings": findings})
            return 1 if any(item["level"] == "error" for item in findings) else 0
        if args.ux_command == "compile":
            value = compile_ux(load_json(args.decision), args.framework)
            emit(value, args.output)
            return 0 if value["valid"] else 1
        if args.ux_command == "payload":
            value = compile_discord_payload(load_json(args.decision), summary=args.summary, detail=args.detail, state=args.state, custom_id=args.custom_id, button_label=args.button_label)
            emit(value, args.output)
            return 0 if value["valid"] else 1
        if args.ux_command == "audit":
            emit(audit_experience(args.root), args.output, **view_args(args))
            return 0
        result = experience_gate(load_json(args.review))
        emit(result)
        return 0 if result["passed"] else 1
    if args.command == "scenario":
        result = run_scenario(load_json(args.scenario))
        emit(result)
        return 0 if result["passed"] else 1
    if args.command == "verification-plan":
        return 0 if emit_validated(make_verification_plan(args.root, args.risk, args.profile), "verification-plan.schema.json", args.output, **view_args(args)) else 1
    if args.command == "verify":
        analysis = analyze_project(args.root)
        plan = make_verification_plan(args.root, args.risk, args.profile)
        command_results = []
        for check in plan["commands"]:
            try:
                completed = subprocess.run(check["command"], cwd=args.root, text=True, capture_output=True, timeout=check["timeout_seconds"], check=False)
                tail_chars = {"low": 1200, "medium": 2000, "high": 4000, "critical": 8000}[args.risk]
                output_text = redact_text(completed.stdout + completed.stderr)
                command_results.append({**check, "attempted": True, "passed": completed.returncode == 0, "returncode": completed.returncode, "output_tail": "" if completed.returncode == 0 else output_text[-tail_chars:]})
            except (OSError, subprocess.TimeoutExpired) as error:
                command_results.append({**check, "attempted": True, "passed": False, "error": redact_text(str(error))})
        required = [item for item in command_results if item["required"]]
        tests_passed = bool(required) and all(item["passed"] for item in required)
        test = {"attempted": bool(command_results), "passed": tests_passed, "commands": command_results, "scenario_checks": plan["scenario_checks"]}
        security_ok = not any(
            item["severity"] == "error" or (args.strict and item["severity"] == "warning")
            for item in analysis["findings"]
        )
        unknowns = list(plan["manual_or_live"])
        if not test["passed"]:
            unknowns.insert(0, "Required repository-native checks did not produce passing evidence.")
        value = receipt(command="verify", checks={"project_model": True, "verification_plan": plan, "tests": test, "security": security_ok, "diff_review": False}, findings=analysis["findings"], unknowns=unknowns)
        schema_ok = emit_validated(value, "evidence-receipt.schema.json", args.output, **view_args(args))
        failed = not schema_ok or not security_ok or not test["passed"]
        return 1 if failed else 0
    if args.command == "schema":
        errors = validate_named(load_json(args.document), args.schema_name)
        emit({"passed": not errors, "schema": args.schema_name, "errors": errors})
        return 1 if errors else 0
    if args.command == "learn":
        return 0 if emit_validated(regression_proposal(load_json(args.incident)), "regression-proposal.schema.json", args.output) else 1
    if args.command == "eval-artifact":
        result = evaluate_artifact(load_json(args.case), load_json(args.artifact))
        emit(result)
        return 0 if result["passed"] else 1
    if args.command == "compare-artifacts":
        result = compare_artifacts(load_json(args.case), load_json(args.baseline), load_json(args.candidate))
        emit(result)
        return 0 if result["passed"] else 1
    if args.command == "proof":
        result = production_proof_gate(load_json(args.evidence), args.target)
        emit(result)
        return 0 if result["passed"] else 1
    if args.command == "evidence":
        value = compress_evidence(load_json(args.document))
        emit(value, args.output)
        return 0
    if args.command == "ledger":
        if args.ledger_command == "init":
            value = new_ledger(args.request, args.root)
            return 0 if emit_validated(value, "context-ledger.schema.json", args.output) else 1
        ledger_value = load_json(args.ledger)
        if args.ledger_command == "summary":
            emit(ledger_summary(ledger_value))
            return 0
        if args.ledger_command == "record":
            fingerprint = args.fingerprint or infer_fingerprint(ledger_value, kind=args.kind, identifier=args.id)
            status = "unverified" if args.kind in {"file", "repository", "command", "evidence"} and not fingerprint else "valid"
            value = record_entry(ledger_value, kind=args.kind, identifier=args.id, fingerprint=fingerprint, status=status)
        else:
            value = invalidate_entry(ledger_value, identifier=args.id, reason=args.reason)
        destination = args.output or str(args.ledger)
        return 0 if emit_validated(value, "context-ledger.schema.json", destination, compact=True) else 1
    if args.command == "semantic":
        value = build_semantic_index(args.root)
        if args.changed:
            value["impact_slice"] = impact_slice(value, args.changed, args.depth)
        emit(value, args.output, **view_args(args))
        return 0
    if args.command == "gate":
        result = completion_gate(load_json(args.contract), load_json(args.receipt))
        emit(result)
        return 0 if result["passed"] else 1
    if args.command == "github":
        if args.github_command == "inspect":
            emit(github_context(args.root), args.output)
            return 0
        if args.github_command == "history":
            emit(git_history(args.root, path=args.path, limit=args.limit), args.output, **view_args(args))
            return 0
        if args.github_command == "workflow-audit":
            result = audit_workflows(args.root)
            emit(result, args.output, **view_args(args))
            serious = any(item["severity"] in {"critical", "high"} or (args.strict and item["severity"] == "medium") for item in result["findings"])
            return 1 if serious else 0
        if args.github_command == "normalize":
            emit(normalize_findings(load_json(args.input), args.source), args.output, **view_args(args))
            return 0
        if args.github_command == "log-triage":
            emit(triage_ci_log(args.log.read_text(encoding="utf-8", errors="replace"), args.source), args.output)
            return 0
        if args.github_command == "contract":
            emit(pull_request_contract(args.request, args.root, args.base), args.output)
            return 0
        if args.github_command == "evidence":
            optional = lambda path: load_json(path) if path else None
            value = github_evidence(args.root, pr=optional(args.pr), checks=optional(args.checks), reviews=optional(args.reviews), findings=optional(args.findings), local=optional(args.local))
            emit(value, args.output, **view_args(args))
            return 0
        if args.github_command == "gate":
            result = github_gate(load_json(args.evidence))
            emit(result)
            return 0 if result["passed"] else 1
        if args.github_command == "release-plan":
            emit(release_plan(args.root, args.version, args.previous_tag), args.output)
            return 0
    if args.command == "eval":
        errors = validate_manifests()
        cases_path = SKILL_ROOT / "assets" / "evals" / "scenarios.json"
        cases = load_json(cases_path).get("scenarios", [])
        results = [run_scenario(case) for case in cases]
        scenario_schema_errors = [f"{case.get('id')}: {error}" for case in cases for error in validate_named(case, "scenario.schema.json")]
        failures = [item for item in results if not item["passed"]]
        mutations = load_json(SKILL_ROOT / "assets" / "evals" / "mutations.json").get("mutations", [])
        mutation_results = []
        for mutation in mutations:
            result = run_scenario(mutation)
            expected = mutation.get("expect_detection")
            detected = expected in result["violations"]
            mutation_results.append({"id": mutation.get("id"), "passed": detected, "expected_detection": expected, "violations": result["violations"]})
        mutation_failures = [item for item in mutation_results if not item["passed"]]
        benchmark_path = SKILL_ROOT / "assets" / "evals" / "discord-bot-engineer-benchmarks.jsonl"
        benchmark_errors: list[str] = []
        benchmark_count = 0
        for line_number, line in enumerate(benchmark_path.read_text(encoding="utf-8").splitlines(), start=1):
            if not line.strip():
                continue
            try:
                case = json.loads(line)
                benchmark_count += 1
                for field in ("id", "profile", "risk", "task", "must_do", "must_not"):
                    if field not in case:
                        benchmark_errors.append(f"line {line_number}: missing {field}")
            except json.JSONDecodeError as error:
                benchmark_errors.append(f"line {line_number}: {error}")
        github_results = evaluate_github_cases(load_json(SKILL_ROOT / "assets" / "evals" / "github-scenarios.json"))
        workflow_results = []
        for case in load_json(SKILL_ROOT / "assets" / "evals" / "closure-experience-sdlc.json").get("cases", []):
            actual: Any
            if case["kind"] == "route":
                actual = case["expect"] if case["expect"] in route_request(case["request"])["routes"] else None
            elif case["kind"] == "sdlc":
                actual = make_sdlc_plan(case["request"], {"risk": case["risk"]})["lifecycle"]
            elif case["kind"] in {"ux", "ux_destructive"}:
                actual = decide_ux(surface=case["surface"], purpose=case["request"].lower(), destructive=case["kind"] == "ux_destructive")["panel"]
            else:
                actual = next((item["id"] for item in make_defect_contract(case["request"], case["risk"])["counterexamples"] if item["id"] == case["expect"]), None)
            workflow_results.append({"id": case["id"], "passed": actual == case["expect"], "expected": case["expect"], "actual": actual})
        workflow_failures = [item for item in workflow_results if not item["passed"]]
        token_budget_results = evaluate_budget_cases(load_json(SKILL_ROOT / "assets" / "evals" / "token-budget-cases.json"))
        token_efficiency_results = evaluate_skill_efficiency(load_json(SKILL_ROOT / "assets" / "evals" / "token-efficiency-gate.json"), (SKILL_ROOT / "SKILL.md").read_text(encoding="utf-8"))
        all_passed = not errors and not failures and not scenario_schema_errors and not mutation_failures and not benchmark_errors and github_results["passed"] and not workflow_failures and token_budget_results["passed"] and token_efficiency_results["passed"]
        value = {"passed": all_passed, "manifest_errors": errors, "benchmark_cases": benchmark_count, "benchmark_errors": benchmark_errors, "scenario_schema_errors": scenario_schema_errors, "scenario_results": results, "mutation_results": mutation_results, "github_results": github_results, "workflow_results": workflow_results, "token_budget_results": token_budget_results, "token_efficiency_results": token_efficiency_results, "limits": ["This deterministic suite does not replace live Discord integration tests, live GitHub connector/Actions tests, rendered browser/client review, or multi-model prompt evaluation."]}
        emit(value, args.output, **view_args(args))
        return 0 if all_passed else 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
