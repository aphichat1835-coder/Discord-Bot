class TicketLifecycle:
    def __init__(self):
        self.by_guild_user = {}

    def open(self, guild_id, user_id, channel_id):
        key = (guild_id, user_id)
        current = self.by_guild_user.get(key)
        if current and current["state"] != "closed":
            return {"ok": False, "reason": "already_open", "ticket": current}
        ticket = {"guild_id": guild_id, "user_id": user_id, "channel_id": channel_id, "state": "open", "transcript": None}
        self.by_guild_user[key] = ticket
        return {"ok": True, "ticket": ticket}

    def begin_close(self, guild_id, user_id):
        ticket = self.by_guild_user.get((guild_id, user_id))
        if not ticket or ticket["state"] != "open":
            return {"ok": False, "reason": "close_in_progress" if ticket and ticket["state"] == "closing" else "not_open"}
        ticket["state"] = "closing"
        return {"ok": True, "ticket": ticket}

    def finish_close(self, guild_id, user_id, transcript):
        ticket = self.by_guild_user.get((guild_id, user_id))
        if not ticket or ticket["state"] != "closing":
            return {"ok": False, "reason": "not_closing"}
        ticket.update(state="closed", transcript=transcript)
        return {"ok": True, "ticket": ticket}

    def recover_close(self, guild_id, user_id, reason):
        ticket = self.by_guild_user.get((guild_id, user_id))
        if not ticket or ticket["state"] != "closing":
            return {"ok": False, "reason": "not_closing"}
        ticket.update(state="open", last_close_error=reason)
        return {"ok": True, "ticket": ticket}
