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
    '''function isCompleteSnapshotSet(stored = {}) {
    if (stored.complete === true) return true;
    if (stored.complete === false) return false;
    const presentKinds = ["profile", "guilds", "connections", "member"]
        .filter(kind => stored[kind]);
    return presentKinds.length > 0 && presentKinds.every(kind =>
        stored[kind]?.complete === true &&
        stored[kind].returnedCount === stored[kind].storedCount
    );
}

function mergeCompleteSnapshotRefs(previousRefs = {}, stored = {}) {
    const next = { ...objectOrEmpty(previousRefs) };
    if (!isCompleteSnapshotSet(stored)) return next;
    const expectedKinds = Array.isArray(stored.expectedKinds)
        ? stored.expectedKinds
        : ["profile", "guilds", "connections", "member"].filter(kind => stored[kind]);
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
    '''        if (!isCompleteSnapshotSet(storedSnapshots)) {
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

route = replace_literal_once(
    route,
    '''        } catch (err) {
            console.error("[VERIFY] saveOAuthUser core failed:", JSON.stringify(sanitizeSideEffectError(err)));
            return {
                saved: false,
                snapshotVersion: storedSnapshots.version,
                snapshotRefs,
                snapshotWrites: storedSnapshots
            };
        }
''',
    '''        } catch (err) {
            console.error("[VERIFY] saveOAuthUser core failed:", JSON.stringify(sanitizeSideEffectError(err)));
            const expectedKinds = Array.isArray(storedSnapshots.expectedKinds)
                ? storedSnapshots.expectedKinds
                : ["profile", "guilds", "connections", "member"].filter(kind => storedSnapshots[kind]);
            const stagedRefs = Object.fromEntries(expectedKinds
                .filter(kind => storedSnapshots[kind])
                .map(kind => [kind, storedSnapshots[kind]]));
            await snapshotStore.rollbackSnapshotVersion({
                userId: profileUserId,
                version: storedSnapshots.version,
                refs: stagedRefs
            });
            return {
                saved: false,
                snapshotVersion: storedSnapshots.version,
                snapshotRefs: existing?.snapshotRefs || null,
                snapshotWrites: storedSnapshots
            };
        }
''',
    "core-write rollback"
)

route_path.write_text(route)

data_contract_path = Path("verification-tests/dataContract.test.js")
data_contract = data_contract_path.read_text()
data_contract = replace_literal_once(
    data_contract,
    '''    test("completed chunk references survive an OAuthUser core write failure", async () => {
''',
    '''    test("a core write failure rolls back staged chunks and preserves active references", async () => {
''',
    "core failure test title"
)
data_contract = replace_literal_once(
    data_contract,
    '''        jest.spyOn(snapshotStore, "storeOAuthSnapshots").mockResolvedValue({
            version: "v-complete",
            guilds: {
''',
    '''        jest.spyOn(snapshotStore, "storeOAuthSnapshots").mockResolvedValue({
            version: "v-complete",
            complete: true,
            expectedKinds: ["guilds", "connections"],
            guilds: {
''',
    "core failure complete snapshot mock"
)
data_contract = replace_literal_once(
    data_contract,
    '''            connections: {
                kind: "connections", version: "v-complete", returnedCount: 1,
                storedCount: 1, chunkCount: 1, complete: true
            }
        });
        const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
''',
    '''            connections: {
                kind: "connections", version: "v-complete", returnedCount: 1,
                storedCount: 1, chunkCount: 1, complete: true
            }
        });
        const rollback = jest.spyOn(snapshotStore, "rollbackSnapshotVersion").mockResolvedValue();
        const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
''',
    "core failure rollback spy"
)
data_contract = replace_literal_once(
    data_contract,
    '''            expect(result.saved).toBe(false);
            expect(result.snapshotVersion).toBe("v-complete");
            expect(result.snapshotRefs.guilds.complete).toBe(true);
            expect(result.snapshotRefs.connections.complete).toBe(true);
            expect(errorLog).toHaveBeenCalled();
''',
    '''            expect(result.saved).toBe(false);
            expect(result.snapshotVersion).toBe("v-complete");
            expect(result.snapshotRefs).toEqual({});
            expect(rollback).toHaveBeenCalledWith({
                userId: "12345678901234567",
                version: "v-complete",
                refs: {
                    guilds: expect.objectContaining({ complete: true }),
                    connections: expect.objectContaining({ complete: true })
                }
            });
            expect(errorLog).toHaveBeenCalled();
''',
    "core failure atomic expectations"
)
data_contract_path.write_text(data_contract)

Path(".github/workflows/redesign-snapshot-storage.yml").unlink(missing_ok=True)
Path("scripts/applyCompleteSnapshotRedesign.py").unlink(missing_ok=True)
unpack("ci.gz.b64", ".github/workflows/ci.yml")
shutil.rmtree(PAYLOAD_DIR)
