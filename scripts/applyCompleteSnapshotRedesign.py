from pathlib import Path
import base64
import gzip
import shutil

PAYLOAD_DIR = Path("scripts/.snapshot-redesign")


def unpack(source_name, destination):
    encoded = (PAYLOAD_DIR / source_name).read_text().strip()
    target = Path(destination)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(gzip.decompress(base64.b64decode(encoded)))


def replace_literal_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label} expected one match, found {count}")
    return text.replace(old, new, 1)


unpack("service.gz.b64", "discord/verification/services/oauthSnapshotStore.js")
unpack("test.gz.b64", "verification-tests/snapshotAggregateBudget.test.js")

route_path = Path("discord/verification/routes/oauth.js")
route = route_path.read_text()

route = replace_literal_once(
    route,
    '''function applySnapshotBudgetGuard(updateSet) {
    return snapshotBudget.assertSnapshotBudget(updateSet, { label: "oauth_user_update" });
}
''',
    '''function applySnapshotBudgetGuard(updateSet) {
    const bytes = snapshotBudget.jsonBytes(updateSet);
    if (!Number.isFinite(bytes) || bytes > snapshotBudget.MAX_MAX_BYTES) {
        const err = new Error("oauth_user_update exceeds MongoDB-safe document size");
        err.code = "snapshot_document_too_large";
        err.bytes = bytes;
        err.maxBytes = snapshotBudget.MAX_MAX_BYTES;
        throw err;
    }
    return { ok: true, bytes, maxBytes: snapshotBudget.MAX_MAX_BYTES, truncated: false };
}
''',
    "applySnapshotBudgetGuard"
)

route = replace_literal_once(
    route,
    '''function mergeCompleteSnapshotRefs(previousRefs = {}, stored = {}) {
    const next = { ...objectOrEmpty(previousRefs) };
    for (const kind of ["profile", "guilds", "connections", "member"]) {
        if (stored[kind]?.complete === true &&
            stored[kind].returnedCount === stored[kind].storedCount) {
            next[kind] = stored[kind];
        }
    }
    return next;
}
''',
    '''function mergeCompleteSnapshotRefs(previousRefs = {}, stored = {}) {
    const next = { ...objectOrEmpty(previousRefs) };
    if (stored.complete !== true) return next;
    const expectedKinds = Array.isArray(stored.expectedKinds)
        ? stored.expectedKinds
        : ["profile", "guilds", "connections", "member"];
    for (const kind of expectedKinds) {
        if (stored[kind]?.complete === true &&
            stored[kind].returnedCount === stored[kind].storedCount) {
            next[kind] = stored[kind];
        }
    }
    next.snapshotSet = {
        version: stored.version || null,
        complete: true,
        expectedKinds,
        activatedAt: Date.now()
    };
    return next;
}
''',
    "mergeCompleteSnapshotRefs"
)

route = replace_literal_once(
    route,
    '''        let snapshotMeta = buildSnapshotMetaUpdate(
''',
    '''        if (storedSnapshots.complete !== true) {
            return {
                saved: false,
                snapshotVersion: storedSnapshots.version,
                snapshotRefs: existing?.snapshotRefs || null,
                snapshotWrites: storedSnapshots
            };
        }
        let snapshotMeta = buildSnapshotMetaUpdate(
''',
    "snapshot-set activation guard"
)

route_path.write_text(route)

Path(".github/workflows/redesign-snapshot-storage.yml").unlink(missing_ok=True)
Path("scripts/applyCompleteSnapshotRedesign.py").unlink(missing_ok=True)
unpack("ci.gz.b64", ".github/workflows/ci.yml")
shutil.rmtree(PAYLOAD_DIR)
