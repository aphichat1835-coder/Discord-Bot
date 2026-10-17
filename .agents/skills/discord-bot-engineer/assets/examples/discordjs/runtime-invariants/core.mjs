export function consumeOAuthState(record, { state, now, sessionId }) {
  if (!record || record.digest !== state) return { ok: false, reason: "invalid_state" };
  if (record.sessionId !== sessionId) return { ok: false, reason: "wrong_session" };
  if (record.usedAt) return { ok: false, reason: "replayed" };
  if (now >= record.expiresAt) return { ok: false, reason: "expired" };
  record.usedAt = now;
  return { ok: true };
}

export class PlayerSession {
  constructor(guildId) {
    this.guildId = guildId;
    this.state = "idle";
    this.track = null;
  }
  start(track) {
    if (this.state === "destroyed") return { ok: false, reason: "destroyed" };
    this.track = track;
    this.state = "playing";
    return { ok: true };
  }
  fail(reason) {
    this.track = null;
    this.state = "idle";
    return { ok: false, reason };
  }
  destroy() {
    this.track = null;
    this.state = "destroyed";
  }
}

export function claimJob(job, { workerId, generation, now, leaseMs }) {
  if (job.completedAt) return { ok: false, reason: "completed" };
  if (job.leaseUntil > now && job.ownerId !== workerId) return { ok: false, reason: "leased" };
  if (generation <= (job.generation ?? 0)) return { ok: false, reason: "stale_generation" };
  Object.assign(job, { ownerId: workerId, generation, leaseUntil: now + leaseMs });
  return { ok: true, fence: generation };
}

export function applyEntitlementEvent(store, event) {
  if (store.events.has(event.id)) return { ok: true, duplicate: true, entitlement: store.entitlements.get(event.entitlementId) };
  const current = store.entitlements.get(event.entitlementId);
  if (current && event.sequence <= current.sequence) return { ok: false, reason: "out_of_order" };
  const entitlement = { id: event.entitlementId, ownerId: event.ownerId, active: event.kind === "grant", sequence: event.sequence };
  store.events.add(event.id);
  store.entitlements.set(event.entitlementId, entitlement);
  return { ok: true, duplicate: false, entitlement };
}
