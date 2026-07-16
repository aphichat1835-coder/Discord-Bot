# Complete Snapshot Storage

Verification snapshots use complete, versioned persistence. Aggregate payload size is not a reason to omit or truncate fetched data.

## Invariants

1. Every fetched profile, guild, connection, member, and member-role value is preserved.
2. Normal arrays are divided into MongoDB-safe item chunks measured with MongoDB BSON sizing, including metadata and field overhead.
3. A single oversized object or item is serialized as UTF-8 JSON and divided into Base64 byte chunks.
4. Every byte chunk stores its own SHA-256 checksum; the reference also stores the checksum and byte length of the complete payload.
5. Readers reject missing, out-of-order, size-mismatched, or checksum-mismatched chunks.
6. Snapshot writes are retried with bounded backoff.
7. A snapshot version becomes active only after every expected component reports `complete: true` and `returnedCount === storedCount`.
8. If any component or the final `OAuthUser` core write fails, the new version is rolled back and the previous active references remain unchanged.
9. Rollback writes must be acknowledged; incomplete rollback state is persisted for bounded exponential recovery retries.
10. Failed optional Discord fetches do not replace previously stored successful snapshots with empty arrays.
11. Snapshot activation is serialized per user and conditionally rejects an older callback when a newer attempt is already active.
12. Object-chunk identity includes `guildId`; the runtime migrates the legacy
    non-guild-scoped unique index before normal cleanup.

## Runtime controls

- `OAUTH_SNAPSHOT_CHUNK_MAX_BYTES`: target maximum for normal item chunks; default 512 KiB.
- `OAUTH_SNAPSHOT_CHUNK_MAX_ITEMS`: maximum items in a normal chunk; default 100.
- `OAUTH_OBJECT_CHUNK_RAW_BYTES`: raw JSON bytes per oversized-object chunk; default 384 KiB.
- `OAUTH_SNAPSHOT_WRITE_RETRY_ATTEMPTS`: bounded write attempts; default 3.
- `OAUTH_SNAPSHOT_WRITE_RETRY_DELAY_MS`: base retry delay; default 150 ms.

The MongoDB per-document safety boundary remains enforced. The former aggregate snapshot ceiling is no longer a data-loss boundary.

## Per-document safety

The effective document ceiling is `VERIFICATION_SNAPSHOT_MAX_BYTES`, capped at
12 MiB. Size checks use the complete `$set` document shape, including metadata,
field names, array wrappers, references, and a safety margin for BSON/Mongoose
overhead. A normal item, profile, or member object that cannot fit safely is
stored with `json-base64-chunks-v1`; the aggregate snapshot may span any number
of documents and is never truncated.

Object chunk size is reduced automatically until every generated chunk document
fits below the effective document ceiling. Each chunk and the reconstructed
payload must pass SHA-256 and byte-length verification before it is returned.

## Rollback recovery

Rollback reports attempted models, failed models, sanitized failure codes, and
per-model mark/delete results. Failed rollback work is recorded in
`OAuthSnapshotRecovery` without user payloads or secrets. Snapshot maintenance
retries those records on a later cleanup pass. Active references to the last
successful snapshot are never replaced by a staged or incompletely rolled-back
version.

`OAuthObjectChunkSnapshot` participates in the same permanent-history cleanup
rules as profile, guild, connection, member, and member-role snapshots:
referenced complete versions are retained, stale incomplete chunks are removed
after the grace period, and unreferenced complete chunks are removed only after
references are checked again immediately before deletion.

Readers reconstruct only finalized versions and reject a missing or duplicate
chunk, a non-contiguous chunk index, inconsistent `chunkCount`, incorrect
stored/returned counts, byte-length drift, or checksum failure. Legacy embedded
snapshots remain readable during migration, but a staged or corrupt new version
never replaces the last complete active reference.
