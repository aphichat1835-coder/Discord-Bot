def consume_oauth_state(record, *, state, now, session_id):
    if not record or record["digest"] != state:
        return {"ok": False, "reason": "invalid_state"}
    if record["session_id"] != session_id:
        return {"ok": False, "reason": "wrong_session"}
    if record.get("used_at") is not None:
        return {"ok": False, "reason": "replayed"}
    if now >= record["expires_at"]:
        return {"ok": False, "reason": "expired"}
    record["used_at"] = now
    return {"ok": True}


class PlayerSession:
    def __init__(self, guild_id):
        self.guild_id = guild_id
        self.state = "idle"
        self.track = None

    def start(self, track):
        if self.state == "destroyed":
            return {"ok": False, "reason": "destroyed"}
        self.track, self.state = track, "playing"
        return {"ok": True}

    def fail(self, reason):
        self.track, self.state = None, "idle"
        return {"ok": False, "reason": reason}

    def destroy(self):
        self.track, self.state = None, "destroyed"


def claim_job(job, *, worker_id, generation, now, lease_ms):
    if job.get("completed_at"):
        return {"ok": False, "reason": "completed"}
    if job.get("lease_until", 0) > now and job.get("owner_id") != worker_id:
        return {"ok": False, "reason": "leased"}
    if generation <= job.get("generation", 0):
        return {"ok": False, "reason": "stale_generation"}
    job.update(owner_id=worker_id, generation=generation, lease_until=now + lease_ms)
    return {"ok": True, "fence": generation}


def apply_entitlement_event(store, event):
    if event["id"] in store["events"]:
        return {"ok": True, "duplicate": True, "entitlement": store["entitlements"].get(event["entitlement_id"])}
    current = store["entitlements"].get(event["entitlement_id"])
    if current and event["sequence"] <= current["sequence"]:
        return {"ok": False, "reason": "out_of_order"}
    entitlement = {"id": event["entitlement_id"], "owner_id": event["owner_id"], "active": event["kind"] == "grant", "sequence": event["sequence"]}
    store["events"].add(event["id"])
    store["entitlements"][event["entitlement_id"]] = entitlement
    return {"ok": True, "duplicate": False, "entitlement": entitlement}
