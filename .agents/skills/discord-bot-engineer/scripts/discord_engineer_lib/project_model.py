from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from .io_utils import SOURCE_SUFFIXES, read_text, relative, walk_files
from .manifest import manifest

FRAMEWORKS = {
    "discord.js": ("discord.js", "@sapphire/framework", "discordx"),
    "discord.py": ("discord.py", "py-cord", "disnake", "nextcord", "interactions.py"),
}
SIGNALS = {
    "commands": r"SlashCommandBuilder|app_commands\.command|bot\.command|hybrid_command",
    "events": r"(?:client|bot)\.(?:on|once)\s*\(|@(?:bot|client)\.event|Cog\.listener",
    "components": r"ButtonBuilder|SelectMenuBuilder|ModalBuilder|discord\.ui\.(?:View|Button|Select|Modal)",
    "responses": r"\.(?:reply|deferReply|editReply|followUp|update|deferUpdate|send_message|defer|edit_original_response)\s*\(",
    "permissions": r"PermissionFlagsBits|PermissionsBitField|has_permissions|bot_has_permissions",
    "lifecycle": r"createMessageComponentCollector|setInterval|setTimeout|asyncio\.create_task|tasks\.loop",
    "persistence": r"prisma|sequelize|typeorm|mongoose|redis|sqlalchemy|asyncpg|sqlite|postgres",
    "voice": r"@discordjs/voice|AudioPlayer|VoiceClient|wavelink|lavalink",
    "dashboard": r"oauth2|passport|express|fastify|fastapi|flask|django|next-auth|authjs",
}


def _json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _resolved_node_versions(root: Path) -> dict[str, str]:
    lock = _json(root / "package-lock.json")
    packages = lock.get("packages", {})
    resolved: dict[str, str] = {}
    if isinstance(packages, dict):
        for name in {item for names in FRAMEWORKS.values() for item in names}:
            value = packages.get(f"node_modules/{name}", {})
            if isinstance(value, dict) and value.get("version"):
                resolved[name] = str(value["version"])
    return resolved


def _workspace_roots(root: Path, package: dict[str, Any]) -> list[str]:
    raw = package.get("workspaces", [])
    patterns = raw.get("packages", []) if isinstance(raw, dict) else raw
    found: set[str] = set()
    if isinstance(patterns, list):
        for pattern in patterns:
            if not isinstance(pattern, str):
                continue
            for candidate in root.glob(pattern):
                resolved = candidate.resolve()
                if resolved.is_relative_to(root) and resolved.is_dir() and (resolved / "package.json").is_file():
                    found.add(resolved.relative_to(root).as_posix())
    return sorted(found)


def build_project_model(root: Path, max_files: int = 4000) -> dict[str, Any]:
    root = root.resolve()
    package = _json(root / "package.json")
    dependency_sections = ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies")
    dependencies: dict[str, str] = {}
    for section in dependency_sections:
        dependencies.update({str(k): str(v) for k, v in package.get(section, {}).items()})
    declarations = "\n".join(
        (read_text(root / name) or "")
        for name in ("pyproject.toml", "requirements.txt", "requirements-dev.txt", "Pipfile")
        if (root / name).is_file()
    )
    resolved_versions = _resolved_node_versions(root)
    frameworks: list[dict[str, Any]] = []
    for family, names in FRAMEWORKS.items():
        found = [name for name in names if name in dependencies or name.lower() in declarations.lower()]
        if found:
            frameworks.append({"family": family, "packages": [{"name": name, "declared": dependencies.get(name), "resolved": resolved_versions.get(name)} for name in found], "confidence": "confirmed"})

    signals: dict[str, list[dict[str, Any]]] = defaultdict(list)
    suffixes: Counter[str] = Counter()
    scanned = 0
    for path in walk_files(root, suffixes=SOURCE_SUFFIXES, max_files=max_files):
        text = read_text(path)
        if text is None:
            continue
        scanned += 1
        suffixes[path.suffix.lower()] += 1
        for kind, pattern in SIGNALS.items():
            matches = list(re.finditer(pattern, text, re.I))
            if matches and len(signals[kind]) < 50:
                signals[kind].append({"path": relative(root, path), "count": len(matches)})

    detected_managers = [name for filename, name in (("pnpm-lock.yaml", "pnpm"), ("yarn.lock", "yarn"), ("bun.lock", "bun"), ("bun.lockb", "bun"), ("package-lock.json", "npm"), ("uv.lock", "uv"), ("poetry.lock", "poetry")) if (root / filename).exists()]
    node_manager = next((name for name in detected_managers if name in {"npm", "pnpm", "yarn", "bun"}), "npm" if package else None)
    python_manager = next((name for name in detected_managers if name in {"uv", "poetry"}), None)
    toolchain = {
        "package_manager": node_manager or python_manager,
        "package_managers": detected_managers,
        "node_package_manager": node_manager,
        "python_package_manager": python_manager,
        "scripts": sorted(package.get("scripts", {}).keys()),
        "typescript": (root / "tsconfig.json").exists(),
        "python": any((root / name).exists() for name in ("pyproject.toml", "requirements.txt", "uv.lock", "poetry.lock")),
        "workspace_roots": _workspace_roots(root, package),
        "script_commands": package.get("scripts", {}),
    }
    workflow_root = root / ".github" / "workflows"
    github = {
        "local_checkout": (root / ".git").exists(),
        "workflows": sorted(relative(root, path) for path in workflow_root.glob("*") if path.is_file()) if workflow_root.is_dir() else [],
        "codeowners": next((name for name in (".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS") if (root / name).is_file()), None),
        "dependabot": next((name for name in (".github/dependabot.yml", ".github/dependabot.yaml") if (root / name).is_file()), None),
        "pull_request_template": next((name for name in (".github/PULL_REQUEST_TEMPLATE.md", ".github/pull_request_template.md") if (root / name).is_file()), None),
    }
    return {
        "version": 1,
        "root": str(root),
        "frameworks": frameworks,
        "toolchain": toolchain,
        "github": github,
        "source": {"scanned_files": scanned, "suffixes": dict(sorted(suffixes.items())), "truncated": scanned >= max_files},
        "signals": dict(sorted(signals.items())),
        "tests": [relative(root, p) for p in walk_files(root, max_files=500) if any(x in p.name.lower() for x in ("test", "spec"))][:100],
        "operations": {
            "environment_files": [name for name in (".env.example", ".env.sample", ".env.template") if (root / name).is_file()],
            "containers": [name for name in ("Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml") if (root / name).is_file()],
            "migration_roots": [name for name in ("migrations", "prisma/migrations", "alembic", "database/migrations") if (root / name).exists()],
        },
        "evidence": [item for item in ("package.json" if package else None, "lockfile resolved versions" if resolved_versions else None, "installed source signals" if scanned else None) if item],
        "capability_source_priority": manifest("capability-sources.json")["priority"],
    }
