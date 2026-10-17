#!/usr/bin/env python3
"""Run deterministic self-tests for bundled Discord engineering tooling."""

from __future__ import annotations

import asyncio
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import ModuleType


ROOT = Path(__file__).resolve().parents[1]


def load(name: str, relative: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {relative}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


inspector = load("skill_inspector", "scripts/inspect_discord_project.py")
auditor = load("skill_auditor", "scripts/audit_discord_project.py")
snapshot = load("skill_snapshot", "scripts/validate_experience_snapshot.py")
locale = load("skill_locale", "scripts/audit_locale_catalogs.py")
benchmarks = load("skill_benchmarks", "scripts/validate_benchmarks.py")
progress_module = load("skill_progress", "assets/patterns/progress_reporter.py")

sys.path.insert(0, str(ROOT / "scripts"))
from discord_engineer_lib.analyzers import analyze_project
from discord_engineer_lib.compact import compact_result, compress_evidence
from discord_engineer_lib.context_ledger import infer_fingerprint, invalidate_entry, ledger_summary, new_ledger, record_entry
from discord_engineer_lib.contracts import completion_gate, make_feature_contract
from discord_engineer_lib.defects import defect_gate, make_defect_contract, scan_neighborhood
from discord_engineer_lib.domains import analyze_domain, domain_gate, make_domain_contract
from discord_engineer_lib.github import audit_workflows, evaluate_github_cases, git_history, github_context, github_gate, normalize_findings, pull_request_contract, release_plan, triage_ci_log
from discord_engineer_lib.manifest import route_request, validate_manifests
from discord_engineer_lib.learning import compare_artifacts, evaluate_artifact, redact_text, regression_proposal
from discord_engineer_lib.project_model import build_project_model
from discord_engineer_lib.scenarios import run_scenario
from discord_engineer_lib.schema_validation import validate_named, validate_value
from discord_engineer_lib.sdlc import make_sdlc_plan, sdlc_gate
from discord_engineer_lib.ux import audit_experience, compile_discord_payload, compile_ux, decide_ux, experience_gate, validate_ux
from discord_engineer_lib.semantic import build_semantic_index, impact_slice
from discord_engineer_lib.proof import production_proof_gate
from discord_engineer_lib.token_budget import evaluate_budget_cases, evaluate_skill_efficiency, make_token_budget
from discord_engineer_lib.verification import make_verification_plan
from discord_engineer_lib.visual import compare_visual_plans, compose_components_v2, make_visual_plan


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def test_inspector_and_auditor() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        write(
            root / "package.json",
            json.dumps({
                "name": "fixture-bot",
                "type": "module",
                "dependencies": {"discord.js": "^14.0.0"},
                "scripts": {"test": "node --test", "typecheck": "tsc --noEmit"},
            }),
        )
        write(
            root / "package-lock.json",
            json.dumps({
                "lockfileVersion": 3,
                "packages": {"node_modules/discord.js": {"version": "14.99.0"}},
            }),
        )
        secret_fixture = "const bot_" + "token = '" + "this-is-a-fake-token-value-for-test" + "';\n"
        write(
            root / "src" / "commands" / "clear.ts",
            """import { SlashCommandBuilder, GatewayIntentBits } from 'discord.js';
""" + secret_fixture + """\
export const data = new SlashCommandBuilder().setName('clear');
export const cancel = new ButtonBuilder().setCustomId('clear:v1:cancel');
export async function execute(interaction) {
  await interaction.deferReply();
  const collector = interaction.channel.createMessageComponentCollector({ filter: () => true });
  const bounded = interaction.channel.createMessageComponentCollector({ filter: () => true, time: 5_000 });
  setInterval(() => collector.resetTimer(), 1000);
  await interaction.editReply('done');
}
""",
        )
        write(
            root / "bot" / "views.py",
            """import asyncio
import time
import requests
import discord

class DurableView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

async def work():
    time.sleep(1)
    requests.get('https://example.invalid')
    asyncio.create_task(asyncio.sleep(1))
""",
        )

        report = inspector.inspect(root, 100)
        assert report["schema_version"] == 2
        assert report["node"]["framework_dependencies"]["discord.js"]["resolved"] == "14.99.0"
        assert report["source_inventory"]["signal_file_counts"]["commands"] >= 1
        assert report["source_inventory"]["interaction_response_calls"]["deferReply"] == 1
        assert report["source_inventory"]["interaction_response_calls"]["editReply"] == 1
        assert report["source_inventory"]["command_declarations"]["clear"] == ["src/commands/clear.ts"]
        assert report["source_inventory"]["custom_id_literals"]["clear:v1:cancel"] == ["src/commands/clear.ts"]

        findings, scanned = auditor.audit(root, 100)
        rules = {finding.rule for finding in findings}
        assert scanned == 2
        assert "secret-literal" in rules
        assert "unbounded-collector" in rules
        assert "blocking-sleep" in rules
        assert "sync-http-in-async-project" in rules
        assert "untracked-task" in rules
        assert sum(finding.rule == "unbounded-collector" for finding in findings) == 1


def test_snapshot_and_locale() -> None:
    valid = {
        "command": "clear",
        "locale": "th-TH",
        "required_states": ["running", "succeeded"],
        "states": [
            {
                "name": "running",
                "surface": "components_v2",
                "copy": {"summary": "กำลังลบ 2 / 10 ข้อความ"},
                "progress": {"mode": "determinate", "completed": 2, "total": 10},
                "controls": [{"id": "clear:v1:cancel:fixture", "action": "cancel", "disabled": False}],
            },
            {
                "name": "succeeded",
                "surface": "components_v2",
                "copy": {"summary": "ลบแล้ว 10 ข้อความ"},
                "progress": {"mode": "none"},
                "controls": [{"id": "clear:v1:cancel:fixture", "action": "cancel", "disabled": True}],
            },
        ],
    }
    assert snapshot.validate_snapshot(valid) == []
    invalid = json.loads(json.dumps(valid))
    invalid["states"][1]["controls"][0]["disabled"] = "false"
    messages = [finding["message"] for finding in snapshot.validate_snapshot(invalid)]
    assert any("boolean" in message for message in messages)

    assert locale.placeholders("Deleted {count}") == locale.placeholders("ลบแล้ว {count}")
    assert locale.placeholders("Deleted {count}") != locale.placeholders("ลบแล้ว ${count}")
    assert locale.placeholders("%(count)d") != locale.placeholders("%(count)s")


def test_benchmark_manifest() -> None:
    path = ROOT / "assets" / "evals" / "discord-bot-engineer-benchmarks.jsonl"
    cases, errors = benchmarks.validate(path)
    assert not errors
    assert len(cases) >= 20
    assert {case["risk"] for case in cases} == {"low", "medium", "high", "critical"}


def test_visual_system() -> None:
    moderation = make_visual_plan(purpose="ลบข้อความจำนวนมาก", command_type="moderation")
    assert moderation["direction"]["id"] == "tactical_admin"
    assert moderation["pattern"]["panel"] == "destructive_confirmation"
    assert moderation["component_palette"]["modal"]["interactive"]["checkbox"] == 23
    assert validate_named(moderation, "visual-experience-plan.schema.json") == []

    taste = {"name": "community", "preferred_directions": ["playful_community"], "density": "comfortable", "brand_intensity": "high", "prefer": ["warm copy"], "avoid": ["generic sparkle"]}
    music = make_visual_plan(purpose="ควบคุมเพลง", command_type="music", taste=taste, panel="media_player")
    assert music["direction"]["id"] == "playful_community"
    assert music["pattern"]["panel"] == "media_player"
    assert music["taste"]["applied"] is True
    assert compare_visual_plans([moderation, music])["passed"] is True
    assert compare_visual_plans([music, copy.deepcopy(music)])["passed"] is False

    spec = {
        "title": "กำลังลบข้อความ",
        "summary": "ตรวจสิทธิ์และขอบเขตก่อนลบ",
        "state": "working",
        "thumbnail_url": "https://example.invalid/icon.png",
        "facts": [{"label": "ขอบเขต", "value": "20 ข้อความ"}],
        "details": ["ยกเลิกได้ก่อนเริ่มลบ"],
        "actions": [{"style": 4, "label": "ยืนยันลบ", "custom_id": "purge:v1:confirm"}, {"style": 5, "label": "ดูคู่มือ", "url": "https://example.invalid/help"}],
    }
    composed = compose_components_v2(spec)
    assert composed["valid"] is True
    assert composed["payload"]["flags"] == 32768
    assert composed["payload"]["allowed_mentions"] == {"parse": []}
    assert composed["payload"]["components"][0]["type"] == 17

    terminal = compose_components_v2({"title": "เสร็จแล้ว", "state": "succeeded", "actions": [{"style": 2, "label": "ทำซ้ำ", "custom_id": "job:v1:repeat"}]})
    assert terminal["payload"]["components"][0]["components"][-1]["components"][0]["disabled"] is True
    premium = compose_components_v2({"title": "Premium", "actions": [{"style": 6, "sku_id": "123"}]})
    assert premium["valid"] is True and premium["payload"]["components"][0]["components"][-1]["components"][0]["sku_id"] == "123"
    duplicate = compose_components_v2({"title": "Bad", "actions": [{"style": 1, "label": "A", "custom_id": "same"}, {"style": 2, "label": "B", "custom_id": "same"}]})
    assert duplicate["valid"] is False


def test_unified_engine() -> None:
    assert validate_manifests() == []
    routed = route_request("ทำคำสั่ง moderation purge พร้อม progress UX ด้วย discord.js")
    assert {"discordjs", "moderation", "experience"}.issubset(set(routed["routes"]))
    assert "github_pr" not in routed["routes"]
    assert "github_pr" in route_request("ช่วยตรวจ PR ล่าสุดบน GitHub")["routes"]
    assert "defect" in route_request("แก้บัคเดิมแล้วแต่ยังพังอยู่")["routes"]
    assert "defect_closure" in route_request("แก้บัคเดิมแล้วแต่ยังพังอยู่")["workflows"]["activated"]
    assert "experience_quality" in routed["workflows"]["activated"]
    assert "domain_invariants" in routed["workflows"]["activated"]
    assert "sdlc" in routed["workflows"]["activated"]
    assert "production_proof" in routed["workflows"]["activated"]
    assert "context_budget" in routed["workflows"]["activated"]
    assert "sdlc" in route_request("วางแผน SDLC สำหรับฟีเจอร์ใหม่")["routes"]

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        write(root / "package.json", json.dumps({"dependencies": {"discord.js": "14.99.0"}, "scripts": {"test": "node --test"}}))
        write(root / "src" / "clear.ts", "async function clear(interaction) { await interaction.deferReply(); await rows.delete(); await interaction.editReply('done'); }")
        model = build_project_model(root)
        assert model["frameworks"][0]["family"] == "discord.js"
        assert model["signals"]["responses"][0]["count"] == 2
        assert validate_named(model, "project-model.schema.json") == []
        analysis = analyze_project(root, {"interaction", "impact"})
        assert any(item["rule"] == "response_call" for item in analysis["findings"])

        write(root / "bot.py", "async def handler(interaction, store):\n    await store.delete()\n    await interaction.response.send_message('done')\n")
        python_analysis = analyze_project(root, {"interaction", "impact"})
        assert any(item["name"] == "handler" for item in python_analysis["symbols"])
        assert any(item["to"] == "store.delete" for item in python_analysis["graphs"]["calls"])
        assert any(item["rule"] == "side_effect_before_visible_response" for item in python_analysis["findings"])

        write(root / "src" / "handler.ts", "import { clear } from './clear';\nexport async function handler(interaction) { const value = interaction.options.getString('value'); await store.update(value); return clear(interaction); }\n")
        semantic = build_semantic_index(root)
        assert any(edge["to"] == "src/clear.ts" for edge in semantic["module_edges"])
        assert any(flow["sink"]["kind"] == "database_write" for flow in semantic["candidate_flows"])
        assert "src/handler.ts" in impact_slice(semantic, ["src/clear.ts"])["affected"]

        write(root / "src" / "economy.ts", "await database.transaction(async () => ledger.insert({ request_id, amount: BigInt(cents) }));")
        domain_analysis = analyze_domain(root, "economy")
        assert {item["id"] for item in domain_analysis["invariants"] if item["status"] == "candidate_evidence"} == {"exact_amount", "atomic_transaction", "idempotency", "ledger"}

        contract = make_feature_contract("moderation purge with progress", root, {"framework": "discord.js"})
        assert contract["risk"] == "high"
        assert validate_named(contract, "feature-contract.schema.json") == []
        failed = completion_gate(contract, {"checks": {"tests": False, "security": True, "diff_review": True}, "unknowns": []})
        assert failed["passed"] is False
        passed = completion_gate(contract, {"checks": {"tests": {"passed": True}, "security": True, "diff_review": True, "traceability": {"passed": True}, "experience_review": {"passed": True}, "domain_review": {"passed": True}, "sdlc": {"passed": True}}, "unknowns": []})
        assert passed["passed"] is True

        domain = make_domain_contract("moderation", "purge with partial failure")
        assert validate_named(domain, "domain-contract.schema.json") == []
        domain_evidence = {
            "invariants": [{**item, "status": "verified"} for item in domain["invariants"]],
            "scenarios": [{**item, "status": "passed"} for item in domain["scenarios"]],
            "security_scenarios": [{**item, "status": "passed"} for item in domain["security_scenarios"]],
            "authorization": {"passed": True},
            "state_and_side_effects": {"passed": True},
            "recovery": {"passed": True},
            "user_visible_truth": {"passed": True},
            "unknowns": [],
            "blockers": [],
        }
        assert domain_gate(domain, domain_evidence)["passed"] is True

        verification = make_verification_plan(root, "high", ["moderation"])
        assert any(item["id"] == "test" for item in verification["commands"])
        assert "partial_failure" in verification["scenario_checks"]

        defect = make_defect_contract("purge sometimes reports success after a delete failure", "high")
        assert validate_named(defect, "defect-contract.schema.json") == []
        neighborhood = scan_neighborhood(root, ["clear"])
        assert any(item["path"] == "src/clear.ts" for item in neighborhood["hits"])
        defect_evidence = {
            "reproduction": {"status": "confirmed"},
            "root_cause": {"confidence": "confirmed", "causal_path": ["delete rejection", "success summary"]},
            "neighborhood_reviewed": True,
            "regression": {"fails_before_fix": True, "passes_after_fix": True},
            "counterexamples": [{**item, "status": "passed"} for item in defect["counterexamples"]],
            "diff_review": True,
            "security_review": True,
            "live_boundary": {"level": "simulated_discord"},
            "unknowns": [],
            "blockers": [],
        }
        assert defect_gate(defect, defect_evidence)["passed"] is True

        lifecycle = make_sdlc_plan("แก้บัค purge", {"risk": "high", "intent": {"goal": "fix purge"}})
        assert lifecycle["lifecycle"] == "patch"
        assert {"design", "uat"} <= set(lifecycle["phases"])
        evidence = {"phases": {phase: {"passed": True} for phase in lifecycle["phases"]}, "traceability": [{"status": "verified"}], "unknowns": [], "blockers": []}
        assert sdlc_gate(lifecycle, evidence)["passed"] is True

    valid = run_scenario({"id": "valid", "steps": [{"action": "defer"}, {"action": "authorize", "allowed": True}, {"action": "succeeded"}]})
    assert valid["passed"] is True
    invalid = run_scenario({"id": "invalid", "steps": [{"action": "effect", "idempotency_key": "x"}, {"action": "succeeded"}]})
    assert invalid["passed"] is False

    decision = decide_ux(surface="components_v2", purpose="destructive purge progress", total_known=True, destructive=True)
    assert decision["copy"]["tier"] == "operational"
    assert decision["panel"] == "destructive_confirmation"
    assert decision["loading"]["pattern"] == "determinate"
    assert decision["motion"]["profile"] == "none"
    assert validate_ux(decision) == []
    compiled = compile_ux(decision, "discord.js")
    assert compiled["valid"] is True
    assert any(item["terminal"] for item in compiled["states"])
    payload = compile_discord_payload(decision, summary="Deleting 2 / 10 messages", state="working", custom_id="purge:v1:cancel:u1")
    assert payload["valid"] is True
    assert payload["payload"]["flags"] == 32768
    assert "content" not in payload["payload"]
    invalid_payload = compile_discord_payload(decision, summary="x", custom_id="x" * 101)
    assert invalid_payload["valid"] is False
    broken = dict(decision)
    broken["motion"] = {"profile": "expressive", "motion_only_meaning": True}
    assert len(validate_ux(broken)) == 2
    assert validate_named(decision, "ux-decision.schema.json") == []

    review = {"major_redesign": True, "checks": {name: {"passed": True} for name in ("flow", "states", "responsive_or_surface", "accessibility", "copy", "visual_evidence", "truthful_feedback", "direction_accepted")}, "unknowns": [], "blockers": []}
    assert experience_gate(review)["passed"] is True

    proposal = regression_proposal({"id": "BUG-1", "symptom": "token abcdefghijklmnopqrstuvwxyz123 leaked", "token": "secret-value", "why_prior_proof_missed": "no live test"})
    assert proposal["sanitized_evidence"]["token"] == "[REDACTED]"
    assert "abcdefghijklmnopqrstuvwxyz123" not in json.dumps(proposal)
    assert validate_named(proposal, "regression-proposal.schema.json") == []
    case = {"id": "x", "must_do": ["a"], "must_not": ["b"]}
    artifact = {"evidenced": ["a"], "avoided": ["b"], "diff_or_answer_review": {"passed": True}, "evidence_integrity": {"passed": True}}
    assert evaluate_artifact(case, artifact)["passed"] is True
    paired = json.loads((ROOT / "assets" / "evals" / "paired-artifact-example.json").read_text(encoding="utf-8"))
    comparison = compare_artifacts(paired["case"], paired["baseline"], paired["candidate"])
    assert comparison["passed"] is True
    assert "verification" in comparison["improvements"]

    proof_evidence = {"deterministic": {name: True for name in ("routing", "schemas", "static_analysis", "focused_tests", "adversarial_cases")}, "repository": {name: True for name in ("project_model", "native_checks", "diff_review", "security_review")}, "unknowns": [], "blockers": []}
    assert production_proof_gate(proof_evidence, "repository_verified")["passed"] is True
    assert production_proof_gate(proof_evidence, "live_verified")["passed"] is False
    proof_document = {"version": 1, "target": "repository_verified", "evidence": proof_evidence, "unknowns": [], "blockers": []}
    assert validate_named(proof_document, "production-proof.schema.json") == []
    assert production_proof_gate(proof_document)["passed"] is True

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        write(root / "page.css", ".card { backdrop-filter: blur(20px); background: linear-gradient(#7c3aed, purple); }")
        assert len(audit_experience(root)["findings"]) == 2

    friendly = decide_ux(surface="ephemeral", purpose="quick acknowledgement", duration_ms=1200)
    assert friendly["copy"]["tier"] == "brief"
    assert friendly["copy"]["placements"]["loading_or_status_headline"]["density"] == "short"
    assert friendly["copy"]["placements"]["panel_summary"]["density"] == "medium"
    assert friendly["copy"]["placements"]["diagnostics"]["density"] == "detailed_on_demand"
    operational_copy = decide_ux(surface="components_v2", purpose="purge progress", total_known=True)["copy_rules"]
    assert "short_primary_headline" in operational_copy and "progressive_disclosure" in operational_copy
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        write(root / "copy.js", "const lines = ['✨ กำลังดำเนินการ โปรดรอสักครู่...', '🧹 กำลังลบข้อความ...', '✅ เรียบร้อยแล้ว'];")
        assert not any(item["rule"].startswith("emoji") for item in audit_experience(root)["findings"])


def test_example_packs() -> None:
    node = subprocess.run(["node", "--test", "assets/examples/discordjs/purge-progress/core.test.mjs", "assets/examples/discordjs/verification-single-use/core.test.mjs", "assets/examples/discordjs/economy-ledger/core.test.mjs", "assets/examples/discordjs/ticket-lifecycle/core.test.mjs", "assets/examples/discordjs/runtime-invariants/core.test.mjs"], cwd=ROOT, capture_output=True, text=True, check=False)
    assert node.returncode == 0, node.stdout + node.stderr
    python = subprocess.run([sys.executable, "-m", "unittest", "assets/examples/discordpy/purge_progress/test_core.py", "assets/examples/discordpy/verification_single_use/test_core.py", "assets/examples/discordpy/economy_ledger/test_core.py", "assets/examples/discordpy/ticket_lifecycle/test_core.py", "assets/examples/discordpy/runtime_invariants/test_core.py"], cwd=ROOT, capture_output=True, text=True, check=False)
    assert python.returncode == 0, python.stdout + python.stderr


def test_token_efficiency() -> None:
    cases = json.loads((ROOT / "assets" / "evals" / "token-budget-cases.json").read_text(encoding="utf-8"))
    evaluated = evaluate_budget_cases(cases)
    assert evaluated["passed"] is True, evaluated
    micro = make_token_budget("เปลี่ยนคำสะกดในข้อความตอบกลับคำสั่ง Discord")
    assert micro["level"] == "micro"
    assert len(micro["references"]["initial"]) <= 1
    incident = make_token_budget("แก้ OAuth dashboard authorization bypass")
    assert incident["level"] == "incident"
    assert "security_and_permissions" in incident["protected_context"]
    assert validate_named(incident, "token-budget.schema.json") == []

    gate = json.loads((ROOT / "assets" / "evals" / "token-efficiency-gate.json").read_text(encoding="utf-8"))
    skill_text = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    efficiency = evaluate_skill_efficiency(gate, skill_text)
    assert efficiency["passed"] is True, efficiency

    full = {"passed": False, "findings": [{"severity": "info", "rule": "i", "path": "a.js", "line": 1}, {"severity": "error", "rule": "e", "path": "b.js", "line": 2}], "unknowns": ["live"]}
    compact = compact_result(full, max_findings=1)
    assert compact["finding_summary"]["total"] == 2
    assert compact["findings"][0]["rule"] == "e"
    assert len(full["findings"]) == 2
    many = {"findings": [{"severity": "warning", "rule": f"r-{index}", "message": "x" * 200} for index in range(100)]}
    assert len(json.dumps(compact_result(many))) < len(json.dumps(many)) / 4
    receipt = compress_evidence({"passed": True, "checks": {"tests": {"passed": True}}, "traceability": [{"requirement_id": "REQ-1", "test_id": "TEST-1", "status": "verified"}]})
    assert receipt["checks"]["tests"] is True
    assert receipt["trace"][0]["requirement_id"] == "REQ-1"

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        ledger = new_ledger("test", root)
        write(root / "bot.js", "one\n")
        fingerprint = infer_fingerprint(ledger, kind="file", identifier="bot.js")
        ledger = record_entry(ledger, kind="file", identifier="bot.js", fingerprint=fingerprint)
        ledger = record_entry(ledger, kind="reference", identifier="platform-contracts.md", fingerprint="sha:1")
        assert ledger_summary(ledger)["valid_entries"] == 2
        write(root / "bot.js", "two\n")
        assert ledger_summary(ledger)["stale_entries"][0]["reason"] == "file_fingerprint_changed"
        ledger = invalidate_entry(ledger, identifier="platform-contracts.md", reason="framework version changed")
        assert ledger_summary(ledger)["invalid_entries"] == 1
        assert validate_named(ledger, "context-ledger.schema.json") == []


def test_github_engine() -> None:
    cases = json.loads((ROOT / "assets" / "evals" / "github-scenarios.json").read_text(encoding="utf-8"))
    evaluated = evaluate_github_cases(cases)
    assert evaluated["passed"] is True, evaluated

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        subprocess.run(["git", "init", "-b", "main"], cwd=root, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.name", "Fixture"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.email", "fixture@example.invalid"], cwd=root, check=True)
        subprocess.run(["git", "remote", "add", "origin", "https://github.com/example/discord-bot.git"], cwd=root, check=True)
        write(root / "package.json", json.dumps({"dependencies": {"discord.js": "14.99.0"}}))
        write(root / ".github" / "workflows" / "ci.yml", """name: ci
on:
  pull_request:
permissions: write-all
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
""")
        subprocess.run(["git", "add", "package.json", ".github/workflows/ci.yml"], cwd=root, check=True)
        subprocess.run(["git", "commit", "-m", "fixture"], cwd=root, check=True, capture_output=True)
        write(root / "notes.txt", "user work\n")

        context = github_context(root)
        assert context["repository"] == "example/discord-bot"
        assert context["branch"] == "main"
        assert len(context["head_sha"]) == 40
        assert context["working_tree"]["changes"][0]["path"] == "notes.txt"
        history = git_history(root, path="package.json", limit=5)
        assert history["available"] is True
        assert history["commits"][0]["subject"] == "fixture"

        workflow = audit_workflows(root)
        rules = {item["rule"] for item in workflow["findings"]}
        assert {"write_all_permissions", "mutable_action_ref", "timeout_absent"} <= rules

        normalized = normalize_findings({"issues": [{"level": "warning", "rule": "x", "file": "bot.js", "line": 4, "message": "same"}, {"level": "warning", "rule": "x", "file": "bot.js", "line": 4, "message": "same"}]}, "codacy")
        assert len(normalized["findings"]) == 1
        assert normalized["duplicates_removed"] == 1
        sarif = normalize_findings({"runs": [{"results": [{"ruleId": "js/test", "level": "error", "message": {"text": "failure"}, "locations": [{"physicalLocation": {"artifactLocation": {"uri": "bot.js"}, "region": {"startLine": 7}}}]}]}]}, "codeql")
        assert sarif["findings"][0]["path"] == "bot.js"
        assert sarif["findings"][0]["line"] == 7
        log = triage_ci_log("TOKEN=do-not-print\nAssertionError: expected 1 to equal 2\nother failure")
        assert log["classification"] == "test"
        assert "do-not-print" not in json.dumps(log)

        contract = pull_request_contract("change GitHub workflow permissions", root, "main")
        assert contract["risk"] == "high"
        assert contract["base_sha"] == context["head_sha"]

        evidence = {"repository": context["repository"], "head_sha": context["head_sha"], "pull_request": {"goal": "fixture", "base_sha": "b" * 40, "mergeable": True}, "checks": [{"required": True, "head_sha": context["head_sha"], "conclusion": "success"}], "reviews": {"decision": "approved", "unresolved_blocking": 0}, "local": {"tests": {"passed": True}, "diff_review": True, "security": True}, "unknowns": []}
        assert github_gate(evidence)["state"] == "ready_to_merge"
        evidence["checks"][0]["head_sha"] = "c" * 40
        assert github_gate(evidence)["passed"] is False

        merged = copy.deepcopy(evidence)
        merged["checks"][0]["head_sha"] = context["head_sha"]
        merged["pull_request"]["merged"] = True
        merged["deployment"] = {"live_discord_verified": True}
        merged["unknowns"] = ["production revision is not confirmed"]
        assert github_gate(merged)["state"] == "merged_unverified_in_production"
        merged["unknowns"] = []
        assert github_gate(merged)["state"] == "merged_verified_in_production"

        plan = release_plan(root, "1.2.3", "v1.2.2")
        assert plan["target"]["tag"] == "v1.2.3"
        assert plan["authority"] == "draft_only_until_explicit_publish_authority"


def test_adversarial_regressions() -> None:
    assert validate_value(True, {"type": "integer"})
    assert validate_value(False, {"type": "number"})
    assert validate_value([], {"type": "array", "minItems": 1})
    assert validate_value(0, {"type": "integer", "minimum": 1})
    assert validate_value(None, {"type": ["integer", "null"]}) == []

    scenarios = json.loads((ROOT / "assets" / "evals" / "scenarios.json").read_text(encoding="utf-8"))["scenarios"]
    assert all(validate_named(case, "scenario.schema.json") == [] for case in scenarios)

    minimal_contract = {"intent": {"goal": "x", "success_criteria": ["x"]}, "route": {"profiles": [], "workflows": {"activated": []}}}
    blocked_receipt = {"passed": False, "checks": {name: {"passed": True} for name in ("diff_review", "tests", "security", "traceability")}, "unknowns": [], "blockers": ["release failed"]}
    assert completion_gate(minimal_contract, blocked_receipt)["passed"] is False

    plan = make_sdlc_plan("add feature", {"risk": "medium"})
    phase_evidence = {"phases": {phase: {"passed": True} for phase in plan["phases"]}, "traceability": [{"status": "verified"}], "unknowns": ["live not checked"], "blockers": []}
    assert sdlc_gate(plan, phase_evidence)["passed"] is False

    review = {"checks": {name: {"passed": True} for name in ("flow", "states", "responsive_or_surface", "accessibility", "copy", "visual_evidence", "truthful_feedback")}, "unknowns": ["client not reviewed"], "blockers": []}
    assert experience_gate(review)["passed"] is False

    domain = make_domain_contract("economy", "transfer")
    blocked_domain = {"invariants": [{"status": "blocked_with_reason"} for _ in domain["invariants"]], "scenarios": [{"status": "blocked_with_reason"} for _ in domain["scenarios"]], "security_scenarios": [{"status": "blocked_with_reason"} for _ in domain["security_scenarios"]], "authorization": {"passed": True}, "state_and_side_effects": {"passed": True}, "recovery": {"passed": True}, "user_visible_truth": {"passed": True}, "unknowns": ["database unavailable"], "blockers": []}
    assert domain_gate(domain, blocked_domain)["passed"] is False

    defect = make_defect_contract("fix bug")
    blocked_defect = {"reproduction": {"status": "blocked_with_reason"}, "root_cause": {"confidence": "strong_inference", "causal_path": ["a"]}, "neighborhood_reviewed": True, "regression": {"fails_before_fix": True, "passes_after_fix": True}, "counterexamples": [{"status": "blocked_with_reason"} for _ in defect["counterexamples"]], "diff_review": True, "security_review": True, "unknowns": ["runtime unavailable"], "blockers": []}
    assert defect_gate(defect, blocked_defect)["passed"] is False

    head = "a" * 40
    github_evidence = {"repository": "x/y", "head_sha": head, "pull_request": {"goal": "x", "base_sha": "b" * 40, "mergeable": True}, "checks": [{"required": True, "head_sha": head, "conclusion": "success"}], "reviews": {"decision": "approved", "unresolved_blocking": 0}, "local": {"tests": {"passed": True}, "diff_review": True, "security": True}, "unknowns": ["rules unavailable"], "findings": [{"severity": "critical", "status": "open"}]}
    assert github_gate(github_evidence)["passed"] is False

    compressed = compress_evidence({"passed": False, "checks": {"tests": "failed", "security": "not_run"}})
    assert compressed["checks"] == {"tests": None, "security": None}

    ephemeral = compile_discord_payload(decide_ux(surface="ephemeral", purpose="setup"), summary="Ready", custom_id="setup:v1")
    assert ephemeral["valid"] is True and ephemeral["payload"]["flags"] == 64
    denied = compile_discord_payload(decide_ux(surface="ephemeral", purpose="setup"), summary="Denied", state="permission_denied", custom_id="setup:v1")
    assert denied["valid"] is True and denied["terminal"] is True and denied["payload"]["components"][0]["components"][0]["disabled"] is True
    assert compile_discord_payload(decide_ux(surface="plain", purpose="settings"), summary="Working", state="working")["valid"] is False
    assert compile_discord_payload(decide_ux(surface="modal", purpose="setup"), summary="Ready")["valid"] is False
    assert compile_discord_payload(decide_ux(surface="plain", purpose="result"), summary="x" * 2001)["valid"] is False
    try:
        decide_ux(surface="plain", purpose="result", duration_ms=-1)
        raise AssertionError("negative duration must fail")
    except ValueError:
        pass
    assert route_request("fix the queue bug")["routes"] == ["defect", "music"]

    fake = ".".join(("MTIzNDU2Nzg5MDEyMzQ1Njc4", "GhIjKl", "abcdefghijklmnopqrstuvwxyz123456"))
    assert fake not in redact_text(f"failure {fake}")
    assert fake not in json.dumps(triage_ci_log(f"Test failed with credential {fake}"))

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        subprocess.run(["git", "init", "-q"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.name", "Fixture"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.email", "fixture@example.invalid"], cwd=root, check=True)
        write(root / "bot.js", "one\n")
        subprocess.run(["git", "add", "bot.js"], cwd=root, check=True)
        subprocess.run(["git", "commit", "-qm", "fixture"], cwd=root, check=True)
        ledger = new_ledger("test", root)
        ledger = record_entry(ledger, kind="command", identifier="tests", fingerprint=infer_fingerprint(ledger, kind="command", identifier="tests"))
        write(root / "bot.js", "two\n")
        assert ledger_summary(ledger)["stale_entries"][0]["reason"] == "repository_content_changed"

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        write(root / "package.json", json.dumps({"scripts": {"test": f'node -e "console.error(\\"{fake}\\");process.exit(1)"'}}))
        write(root / "package-lock.json", json.dumps({"lockfileVersion": 3, "packages": {}}))
        completed = subprocess.run([sys.executable, "scripts/discord_engineer.py", "verify", str(root)], cwd=ROOT, text=True, capture_output=True, check=False)
        assert completed.returncode == 1
        assert fake not in completed.stdout + completed.stderr


async def test_python_progress_reporter() -> None:
    published: list[dict[str, object]] = []

    async def publish(state: object) -> None:
        await asyncio.sleep(0)
        published.append(dict(state))

    reporter = progress_module.ProgressReporter(publish=publish, min_interval=0)
    reporter.phase("running", completed=0, total=2, failed=0, skipped=0)
    reporter.update(completed=1)
    await reporter.finalize(phase="succeeded", completed=2)
    assert published[-1]["phase"] == "succeeded"
    try:
        reporter.update(completed=2)
    except RuntimeError:
        pass
    else:
        raise AssertionError("closed reporter accepted an update")


def main() -> int:
    test_inspector_and_auditor()
    test_snapshot_and_locale()
    test_benchmark_manifest()
    test_visual_system()
    test_unified_engine()
    test_github_engine()
    test_adversarial_regressions()
    test_example_packs()
    test_token_efficiency()
    asyncio.run(test_python_progress_reporter())
    print("skill tooling self-test: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
