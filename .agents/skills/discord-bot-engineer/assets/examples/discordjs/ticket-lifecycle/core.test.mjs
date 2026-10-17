import test from "node:test";
import assert from "node:assert/strict";
import { TicketLifecycle } from "./core.mjs";

test("prevents duplicate open and serializes close", () => {
  const tickets = new TicketLifecycle();
  assert.equal(tickets.open({ guildId: "g", userId: "u", channelId: "c" }).ok, true);
  assert.equal(tickets.open({ guildId: "g", userId: "u", channelId: "c2" }).reason, "already_open");
  assert.equal(tickets.beginClose({ guildId: "g", userId: "u" }).ok, true);
  assert.equal(tickets.beginClose({ guildId: "g", userId: "u" }).reason, "close_in_progress");
  assert.equal(tickets.finishClose({ guildId: "g", userId: "u", transcript: "ref:1" }).ticket.state, "closed");
});

test("recovers a partial close without claiming success", () => {
  const tickets = new TicketLifecycle();
  tickets.open({ guildId: "g", userId: "u", channelId: "c" });
  tickets.beginClose({ guildId: "g", userId: "u" });
  assert.equal(tickets.recoverClose({ guildId: "g", userId: "u", reason: "upload failed" }).ticket.state, "open");
});
