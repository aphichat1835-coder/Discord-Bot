from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Iterable

IGNORED_DIRS = {".git", ".hg", ".svn", "node_modules", ".venv", "venv", "env", "dist", "build", "coverage", ".next", ".nuxt", ".cache", "__pycache__"}
SOURCE_SUFFIXES = {".js", ".cjs", ".mjs", ".jsx", ".ts", ".tsx", ".py"}


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def dump_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)


def walk_files(root: Path, *, suffixes: set[str] | None = None, max_files: int = 4000) -> Iterable[Path]:
    count = 0
    for directory, directory_names, file_names in os.walk(root):
        directory_names[:] = [name for name in directory_names if name not in IGNORED_DIRS]
        current = Path(directory)
        for name in file_names:
            path = current / name
            if suffixes is not None and path.suffix.lower() not in suffixes:
                continue
            if count >= max_files:
                return
            count += 1
            yield path


def read_text(path: Path, max_bytes: int = 750_000) -> str | None:
    try:
        if path.stat().st_size > max_bytes:
            return None
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def relative(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()
