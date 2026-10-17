import test from "node:test";
import assert from "node:assert/strict";
import { PlayerSession, applyEntitlementEvent, claimJob, consumeOAuthState } from "./core.mjs";

test("OAuth state is session-bound expiring and single-use", () => {
  const record = { digest: "d", sessionId: "s", expiresAt: 20, usedAt: null };
  assert.equal(consumeOAuthState(record, { state: "d", sessionId: "wrong", now: 10 }).reason, "wrong_session");
  assert.equal(consumeOAuthState(record, { state: "d", sessionId: "s", now: 10 }).ok, true);
  assert.equal(consumeOAuthState(record, { state: "d", sessionId: "s", now: 11 }).reason, "replayed");
});

test("player failure and destroy end in explicit clean states", () => {
  const player = new PlayerSession("g");
  player.start("track");
  assert.equal(player.fail("media error").reason, "media error");
  assert.equal(player.track, null);
  player.destroy();
  assert.equal(player.start("late").reason, "destroyed");
});

test("job fencing rejects live owner and stale generations", () => {
  const job = { generation: 0, leaseUntil: 0, ownerId: null, completedAt: null };
  assert.equal(claimJob(job, { workerId: "a", generation: 1, now: 10, leaseMs: 10 }).ok, true);
  assert.equal(claimJob(job, { workerId: "b", generation: 2, now: 11, leaseMs: 10 }).reason, "leased");
  assert.equal(claimJob(job, { workerId: "b", generation: 1, now: 21, leaseMs: 10 }).reason, "stale_generation");
});

test("entitlement events are idempotent and ordered", () => {
  const store = { events: new Set(), entitlements: new Map() };
  const grant = { id: "e1", entitlementId: "p1", ownerId: "u", kind: "grant", sequence: 1 };
  assert.equal(applyEntitlementEvent(store, grant).entitlement.active, true);
  assert.equal(applyEntitlementEvent(store, grant).duplicate, true);
  assert.equal(applyEntitlementEvent(store, { ...grant, id: "old", kind: "revoke", sequence: 0 }).reason, "out_of_order");
});
