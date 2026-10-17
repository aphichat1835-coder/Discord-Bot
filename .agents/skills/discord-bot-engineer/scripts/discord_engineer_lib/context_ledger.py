from __future__ import annotations

import subprocess
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _git(root: Path, *args: str) -> str | None:
    try:
        result = subprocess.run(["git", *args], cwd=root, text=True, capture_output=True, timeout=5, check=False)
        return result.stdout.strip() if result.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def _repository_fingerprint(root: Path) -> str | None:
    head = _git(root, "rev-parse", "HEAD")
    if head is None:
        return None
    changed = _git(root, "diff", "--name-only", "HEAD")
    raw_changes = _git(root, "diff", "--raw", "HEAD")
    untracked = _git(root, "ls-files", "--others", "--exclude-standard")
    if changed is None or raw_changes is None or untracked is None:
        return None
    digest = hashlib.sha256()
    digest.update(head.encode())
    digest.update(b"\0git-raw\0" + raw_changes.encode("utf-8", errors="surrogateescape"))
    for name in sorted(set(changed.splitlines()) | set(untracked.splitlines())):
        digest.update(b"\0" + name.encode("utf-8", errors="surrogateescape") + b"\0")
        path = (root / name).resolve()
        if root.resolve() not in path.parents:
            digest.update(b"outside")
            continue
        try:
            with path.open("rb") as stream:
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
        except OSError:
            digest.update(b"missing")
    return "repo-sha256:" + digest.hexdigest()


def new_ledger(request: str, root: Path) -> dict[str, Any]:
    return {"version": 1, "created_at": datetime.now(timezone.utc).isoformat(), "request": request, "repository": {"root": str(root.resolve()), "head_sha": _git(root, "rev-parse", "HEAD"), "working_fingerprint": _repository_fingerprint(root), "branch": _git(root, "branch", "--show-current")}, "entries": [], "invalidations": [], "policy": "Reuse an entry only while its fingerprint, repository revision, requirement, and evidence boundary remain valid."}


def record_entry(ledger: dict[str, Any], *, kind: str, identifier: str, fingerprint: str | None = None, status: str = "valid") -> dict[str, Any]:
    entries = [item for item in ledger.get("entries", []) if not (item.get("kind") == kind and item.get("id") == identifier)]
    entries.append({"kind": kind, "id": identifier, "fingerprint": fingerprint, "status": status, "recorded_at": datetime.now(timezone.utc).isoformat()})
    return {**ledger, "entries": entries}


def infer_fingerprint(ledger: dict[str, Any], *, kind: str, identifier: str) -> str | None:
    if kind in {"repository", "command", "evidence"}:
        root = Path(str(ledger.get("repository", {}).get("root", ".")))
        return _repository_fingerprint(root)
    if kind != "file":
        return None
    root = Path(str(ledger.get("repository", {}).get("root", "."))).resolve()
    path = (root / identifier).resolve()
    if root not in path.parents and path != root:
        return None
    try:
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
        return "sha256:" + digest.hexdigest()
    except OSError:
        return None


def invalidate_entry(ledger: dict[str, Any], *, identifier: str, reason: str) -> dict[str, Any]:
    entries = [{**item, "status": "invalid" if item.get("id") == identifier else item.get("status", "valid")} for item in ledger.get("entries", [])]
    invalidations = [*ledger.get("invalidations", []), {"id": identifier, "reason": reason, "at": datetime.now(timezone.utc).isoformat()}]
    return {**ledger, "entries": entries, "invalidations": invalidations}


def ledger_summary(ledger: dict[str, Any]) -> dict[str, Any]:
    repository = ledger.get("repository", {})
    root = Path(str(repository.get("root", ".")))
    current_head = _git(root, "rev-parse", "HEAD")
    current_working = _repository_fingerprint(root)
    head_changed = bool(repository.get("head_sha") and current_head and repository.get("head_sha") != current_head)
    valid, invalid, stale = [], [], []
    for item in ledger.get("entries", []):
        if item.get("status") != "valid":
            invalid.append(item)
            continue
        reason = None
        if item.get("kind") in {"command", "evidence", "repository"}:
            if item.get("fingerprint") and item.get("fingerprint") != current_working:
                reason = "repository_content_changed"
            elif head_changed:
                reason = "repository_head_changed"
        elif item.get("kind") == "file" and item.get("fingerprint"):
            current = infer_fingerprint(ledger, kind="file", identifier=str(item.get("id")))
            if current != item.get("fingerprint"):
                reason = "file_fingerprint_changed"
        if reason:
            stale.append({"kind": item.get("kind"), "id": item.get("id"), "reason": reason})
        else:
            valid.append(item)
    return {"version": 1, "request": ledger.get("request"), "repository": {**repository, "current_head_sha": current_head, "current_working_fingerprint": current_working, "head_changed": head_changed}, "valid_entries": len(valid), "invalid_entries": len(invalid), "stale_entries": stale, "reusable": [{"kind": item.get("kind"), "id": item.get("id"), "fingerprint": item.get("fingerprint")} for item in valid], "invalidations": ledger.get("invalidations", [])}
