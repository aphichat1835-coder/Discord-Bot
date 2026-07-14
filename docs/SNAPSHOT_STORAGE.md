# Complete Snapshot Storage

Verification snapshots use complete, versioned persistence. Aggregate payload size is not a reason to omit or truncate fetched data.

## Invariants

1. Every fetched profile, guild, connection, member, and member-role value is preserved.
2. Normal arrays are divided into MongoDB-safe item chunks.
3. A single oversized object or item is serialized as UTF-8 JSON and divided into Base64 byte chunks.
4. Every byte chunk stores its own SHA-256 checksum; the reference also stores the checksum and byte length of the complete payload.
5. Readers reject missing, out-of-order, size-mismatched, or checksum-mismatched chunks.
6. Snapshot writes are retried with bounded backoff.
7. A snapshot version becomes active only after every expected component reports `complete: true` and `returnedCount === storedCount`.
8. If any component or the final `OAuthUser` core write fails, the new version is rolled back and the previous active references remain unchanged.
9. Failed optional Discord fetches do not replace previously stored successful snapshots with empty arrays.

## Runtime controls

- `OAUTH_SNAPSHOT_CHUNK_MAX_BYTES`: target maximum for normal item chunks; default 512 KiB.
- `OAUTH_SNAPSHOT_CHUNK_MAX_ITEMS`: maximum items in a normal chunk; default 100.
- `OAUTH_OBJECT_CHUNK_RAW_BYTES`: raw JSON bytes per oversized-object chunk; default 384 KiB.
- `OAUTH_SNAPSHOT_WRITE_RETRY_ATTEMPTS`: bounded write attempts; default 3.
- `OAUTH_SNAPSHOT_WRITE_RETRY_DELAY_MS`: base retry delay; default 150 ms.

The MongoDB per-document safety boundary remains enforced. The former aggregate snapshot ceiling is no longer a data-loss boundary.
