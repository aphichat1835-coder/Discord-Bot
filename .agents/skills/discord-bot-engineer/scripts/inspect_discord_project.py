#!/usr/bin/env python3
"""Produce a safe, read-only structural inventory of a Discord project."""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import json
import os
from pathlib import Path
import re
from typing import Any, Iterable


LOCKFILES = {
    "package-lock.json": "npm",
    "npm-shrinkwrap.json": "npm",
    "pnpm-lock.yaml": "pnpm",
    "yarn.lock": "yarn",
    "bun.lock": "bun",
    "bun.lockb": "bun",
    "uv.lock": "uv",
    "poetry.lock": "poetry",
    "pdm.lock": "pdm",
}
FRAMEWORK_KEYS = (
    "discord.js",
    "@sapphire/framework",
    "discordx",
    "discord.py",
    "py-cord",
    "disnake",
    "nextcord",
    "discord-py-interactions",
    "interactions.py",
)
IGNORED_DIRS = {
    ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "env",
    "dist", "build", "coverage", ".next", ".nuxt", ".cache", "__pycache__",
}
SOURCE_SUFFIXES = {".js", ".cjs", ".mjs", ".jsx", ".ts", ".tsx", ".py"}
MARKERS = {
    "AGENTS.md", "package.json", "tsconfig.json", "jsconfig.json", "pyproject.toml",
    "requirements.txt", "requirements-dev.txt", "Dockerfile", "docker-compose.yml",
    "compose.yaml", ".env.example", "alembic.ini", "prisma.schema",
}

SIGNALS: dict[str, tuple[re.Pattern[str], ...]] = {
    "commands": (
        re.compile(r"\bSlashCommandBuilder\b|\bContextMenuCommandBuilder\b"),
        re.compile(r"@(?:app_commands\.)?command\b|@bot\.command\b"),
    ),
    "events": (
        re.compile(r"\b(?:client|bot)\.(?:on|once)\s*\("),
        re.compile(r"@(?:bot|client)\.event\b|@commands\.Cog\.listener\b"),
    ),
    "components_modals": (
        re.compile(r"\b(?:ButtonBuilder|StringSelectMenuBuilder|ModalBuilder|ActionRowBuilder)\b"),
        re.compile(r"\bdiscord\.ui\.(?:View|Button|Select|Modal)\b|@discord\.ui\.button\b"),
    ),
    "interaction_responses": (
        re.compile(r"\b(?:interaction|ctx|i)\.(?:reply|deferReply|editReply|followUp|update|deferUpdate)\s*\("),
        re.compile(r"\b(?:interaction|ctx)\.(?:response\.)?(?:send_message|defer|edit_original_response|send_modal)\s*\("),
        re.compile(r"\b(?:interaction|ctx)\.followup\.send\s*\("),
    ),
    "collectors_tasks_timers": (
        re.compile(r"\bcreateMessageComponentCollector\b|\bawaitMessageComponent\b"),
        re.compile(r"\bsetInterval\s*\(|\bsetTimeout\s*\("),
        re.compile(r"\basyncio\.create_task\s*\(|@tasks\.loop\b"),
    ),
    "permissions_intents": (
        re.compile(r"\b(?:GatewayIntentBits|PermissionFlagsBits|PermissionsBitField)\b"),
        re.compile(r"\b(?:Intents|Permissions)\b|\bhas_permissions\b|\bbot_has_permissions\b"),
    ),
    "voice_music": (
        re.compile(r"\b@discordjs/voice\b|\bVoiceConnection\b|\bAudioPlayer\b|\bLavalink\b", re.I),
        re.compile(r"\bVoiceClient\b|\bFFmpegPCMAudio\b|\bwavelink\b", re.I),
    ),
    "sharding_jobs": (
        re.compile(r"\bShardingManager\b|\bbroadcastEval\b|\bworker_threads\b"),
        re.compile(r"\bAutoShardedClient\b|\bAutoShardedBot\b|\bcelery\b|\barq\b"),
    ),
    "persistence_integrations": (
        re.compile(r"\b(?:prisma|sequelize|typeorm|mongoose|redis|bullmq|postgres|mysql|sqlite)\b", re.I),
        re.compile(r"\b(?:sqlalchemy|asyncpg|aiosqlite|redis|motor|pymongo|httpx|aiohttp)\b", re.I),
    ),
    "oauth_dashboard": (
        re.compile(r"\b(?:oauth2|passport|express|fastify|next-auth|authjs)\b", re.I),
        re.compile(r"\b(?:fastapi|flask|django|oauthlib)\b", re.I),
    ),
}


def load_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def walk_files(root: Path, *, max_depth: int = 8) -> Iterable[Path]:
    for directory, directory_names, file_names in os.walk(root):
        current = Path(directory)
        relative = current.relative_to(root)
        depth = 0 if relative == Path(".") else len(relative.parts)
        directory_names[:] = [
            name for name in directory_names
            if name not in IGNORED_DIRS and not name.startswith(".tox") and depth < max_depth
        ]
        if depth > max_depth:
            continue
        for name in file_names:
            yield current / name


def relative_files(root: Path, names: set[str], max_depth: int = 5) -> list[str]:
    return sorted({
        path.relative_to(root).as_posix()
        for path in walk_files(root, max_depth=max_depth)
        if path.name in names
    })


def read_source(path: Path, max_bytes: int = 750_000) -> str | None:
    try:
        if path.stat().st_size > max_bytes:
            return None
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def resolved_node_version(root: Path, package_name: str, package_lock: dict[str, Any] | None) -> str | None:
    installed = load_json(root / "node_modules" / package_name / "package.json")
    if installed and isinstance(installed.get("version"), str):
        return installed["version"]
    if package_lock:
        packages = package_lock.get("packages")
        if isinstance(packages, dict):
            entry = packages.get(f"node_modules/{package_name}")
            if isinstance(entry, dict) and isinstance(entry.get("version"), str):
                return entry["version"]
        dependencies = package_lock.get("dependencies")
        if isinstance(dependencies, dict):
            entry = dependencies.get(package_name)
            if isinstance(entry, dict) and isinstance(entry.get("version"), str):
                return entry["version"]
    return None


def inspect_package_json(root: Path) -> dict[str, Any] | None:
    data = load_json(root / "package.json")
    if data is None:
        return None
    package_lock = load_json(root / "package-lock.json") or load_json(root / "npm-shrinkwrap.json")
    dependencies: dict[str, dict[str, str | None]] = {}
    for section in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
        values = data.get(section)
        if not isinstance(values, dict):
            continue
        for key in FRAMEWORK_KEYS:
            if key in values:
                dependencies[key] = {
                    "declared": str(values[key]),
                    "resolved": resolved_node_version(root, key, package_lock),
                }
    scripts = data.get("scripts") if isinstance(data.get("scripts"), dict) else {}
    return {
        "name": data.get("name"),
        "module_type": data.get("type", "commonjs-default"),
        "engines": data.get("engines", {}),
        "framework_dependencies": dependencies,
        "available_scripts": sorted(scripts.keys()),
    }


def inspect_python(root: Path) -> dict[str, Any] | None:
    manifests = [
        path for path in ("pyproject.toml", "requirements.txt", "requirements-dev.txt", "Pipfile")
        if (root / path).is_file()
    ]
    if not manifests:
        return None
    declarations: dict[str, list[str]] = defaultdict(list)
    for name in manifests:
        text = read_source(root / name) or ""
        for line in text.splitlines():
            lowered = line.lower()
            for key in FRAMEWORK_KEYS:
                if key.lower() in lowered:
                    declarations[key].append(line.strip()[:240])
    return {
        "manifests": manifests,
        "framework_declarations": dict(sorted(declarations.items())),
    }


def classify_source(path: Path, text: str) -> set[str]:
    relative = path.as_posix().lower()
    categories: set[str] = set()
    path_rules = {
        "commands": ("/command", "/commands/", "/cogs/"),
        "events": ("/event", "/events/", "/listeners/"),
        "components_modals": ("/component", "/components/", "/views/", "/modals/"),
        "tests": ("/test", "/tests/", "/__tests__/", ".test.", ".spec."),
        "migrations": ("/migration", "/migrations/", "/alembic/", "/prisma/"),
    }
    for category, needles in path_rules.items():
        if any(needle in f"/{relative}" for needle in needles):
            categories.add(category)
    for category, patterns in SIGNALS.items():
        if any(pattern.search(text) for pattern in patterns):
            categories.add(category)
    return categories


def inspect_sources(root: Path, max_files: int) -> dict[str, Any]:
    counts: Counter[str] = Counter()
    examples: dict[str, list[str]] = defaultdict(list)
    suffixes: Counter[str] = Counter()
    response_methods: Counter[str] = Counter()
    command_declarations: dict[str, list[str]] = defaultdict(list)
    custom_id_literals: dict[str, list[str]] = defaultdict(list)
    dynamic_custom_ids: list[str] = []
    scanned = 0
    skipped_large_or_binary = 0
    truncated = False

    response_pattern = re.compile(
        r"\b(?:interaction|ctx|i)\.(?:response\.)?"
        r"(reply|deferReply|editReply|followUp|update|deferUpdate|send_message|defer|"
        r"edit_original_response|send_modal)\s*\(|"
        r"\b(?:interaction|ctx)\.followup\.send\s*\("
    )
    command_patterns = (
        re.compile(r"(?:SlashCommandBuilder|ContextMenuCommandBuilder)\s*\(\s*\)\s*\.setName\s*\(\s*[\"']([^\"']+)[\"']", re.S),
        re.compile(r"@(?:app_commands\.)?command\s*\([^)]*\bname\s*=\s*[\"']([^\"']+)[\"']", re.S),
        re.compile(r"@(?:bot|client)\.command\s*\([^)]*\bname\s*=\s*[\"']([^\"']+)[\"']", re.S),
    )
    custom_id_patterns = (
        re.compile(r"\.setCustomId\s*\(\s*[\"']([^\"']+)[\"']\s*\)"),
        re.compile(r"\bcustom_id\s*=\s*[\"']([^\"']+)[\"']"),
    )
    dynamic_custom_id_pattern = re.compile(
        r"\.setCustomId\s*\(\s*(?:`[^`]*\$\{|[^\"'\s][^)]*)|\bcustom_id\s*=\s*f[\"']"
    )

    for path in walk_files(root):
        if path.suffix.lower() not in SOURCE_SUFFIXES:
            continue
        if scanned >= max_files:
            truncated = True
            break
        text = read_source(path)
        if text is None:
            skipped_large_or_binary += 1
            continue
        scanned += 1
        suffixes[path.suffix.lower()] += 1
        relative = path.relative_to(root).as_posix()
        for category in classify_source(Path(relative), text):
            counts[category] += 1
            if len(examples[category]) < 8:
                examples[category].append(relative)
        for match in response_pattern.finditer(text):
            method = "followup.send" if match.group(1) is None else match.group(1)
            response_methods[method] += 1
        for pattern in command_patterns:
            for match in pattern.finditer(text):
                if len(command_declarations[match.group(1)]) < 8:
                    command_declarations[match.group(1)].append(relative)
        for pattern in custom_id_patterns:
            for match in pattern.finditer(text):
                if len(custom_id_literals[match.group(1)]) < 8:
                    custom_id_literals[match.group(1)].append(relative)
        if dynamic_custom_id_pattern.search(text) and len(dynamic_custom_ids) < 20:
            dynamic_custom_ids.append(relative)

    return {
        "scanned_files": scanned,
        "truncated": truncated,
        "skipped_large_or_binary": skipped_large_or_binary,
        "languages_by_suffix": dict(sorted(suffixes.items())),
        "signal_file_counts": dict(sorted(counts.items())),
        "signal_examples": {key: value for key, value in sorted(examples.items())},
        "interaction_response_calls": dict(sorted(response_methods.items())),
        "command_declarations": dict(sorted(command_declarations.items())),
        "possible_duplicate_commands": {
            name: paths for name, paths in sorted(command_declarations.items()) if len(set(paths)) > 1
        },
        "custom_id_literals": dict(sorted(custom_id_literals.items())),
        "dynamic_custom_id_files": sorted(set(dynamic_custom_ids)),
    }


def inspect(root: Path, max_files: int) -> dict[str, Any]:
    marker_files = relative_files(root, MARKERS | set(LOCKFILES))
    managers = sorted({LOCKFILES[Path(path).name] for path in marker_files if Path(path).name in LOCKFILES})
    workflow_root = root / ".github" / "workflows"
    workflows = []
    if workflow_root.is_dir():
        workflows = sorted(path.relative_to(root).as_posix() for path in workflow_root.glob("*") if path.is_file())
    env_files = sorted(path.relative_to(root).as_posix() for path in root.glob(".env*") if path.is_file())
    common_roots = [
        name for name in (
            "src", "bot", "app", "discord", "commands", "events", "cogs", "extensions",
            "services", "repositories", "database", "api", "dashboard", "test", "tests", "__tests__",
        ) if (root / name).exists()
    ]
    return {
        "schema_version": 2,
        "root": str(root),
        "markers": marker_files,
        "package_managers": managers,
        "node": inspect_package_json(root),
        "python": inspect_python(root),
        "common_roots": common_roots,
        "workflow_files": workflows,
        "environment_file_names_only": env_files,
        "source_inventory": inspect_sources(root, max_files),
        "notes": [
            "No environment file contents were read.",
            "Resolved versions are reported only when installed/package-lock evidence was found.",
            "Signal counts are heuristic navigation aids; confirm behavior through call paths and tests.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project_root", nargs="?", default=".")
    parser.add_argument("--max-files", type=int, default=4000, help="maximum source files to inspect")
    args = parser.parse_args()
    root = Path(args.project_root).expanduser().resolve()
    if not root.is_dir():
        parser.error(f"not a directory: {root}")
    if args.max_files < 1:
        parser.error("--max-files must be positive")
    print(json.dumps(inspect(root, args.max_files), indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
