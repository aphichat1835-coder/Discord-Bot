export class TicketLifecycle {
  constructor() {
    this.byGuildUser = new Map();
  }

  open({ guildId, userId, channelId }) {
    const key = `${guildId}:${userId}`;
    const current = this.byGuildUser.get(key);
    if (current && current.state !== "closed") return { ok: false, reason: "already_open", ticket: current };
    const ticket = { guildId, userId, channelId, state: "open", transcript: null };
    this.byGuildUser.set(key, ticket);
    return { ok: true, ticket };
  }

  beginClose({ guildId, userId }) {
    const ticket = this.byGuildUser.get(`${guildId}:${userId}`);
    if (!ticket || ticket.state !== "open") return { ok: false, reason: ticket?.state === "closing" ? "close_in_progress" : "not_open" };
    ticket.state = "closing";
    return { ok: true, ticket };
  }

  finishClose({ guildId, userId, transcript }) {
    const ticket = this.byGuildUser.get(`${guildId}:${userId}`);
    if (!ticket || ticket.state !== "closing") return { ok: false, reason: "not_closing" };
    ticket.transcript = transcript;
    ticket.state = "closed";
    return { ok: true, ticket };
  }

  recoverClose({ guildId, userId, reason }) {
    const ticket = this.byGuildUser.get(`${guildId}:${userId}`);
    if (!ticket || ticket.state !== "closing") return { ok: false, reason: "not_closing" };
    ticket.state = "open";
    ticket.lastCloseError = reason;
    return { ok: true, ticket };
  }
}
