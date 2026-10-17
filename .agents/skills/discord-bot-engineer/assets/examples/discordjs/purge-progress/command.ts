import { MessageFlags, PermissionFlagsBits, type ChatInputCommandInteraction, type Message } from "discord.js";
import { createPurgeState, progressCopy, transition } from "./core.mjs";

export async function executePurge(interaction: ChatInputCommandInteraction, selected: Message[]): Promise<void> {
  if (!interaction.inCachedGuild() || !interaction.memberPermissions.has(PermissionFlagsBits.ManageMessages)) {
    await interaction.reply({ content: "คุณไม่มีสิทธิ์จัดการข้อความในห้องนี้", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let state = transition(createPurgeState({ actorId: interaction.user.id, total: selected.length }), { type: "start" });
  await interaction.editReply(progressCopy(state));

  for (const message of selected) {
    let event;
    try {
      if (!message.deletable) event = { type: "batch", attempted: 1, deleted: 0, skipped: 1, failed: 0 };
      else {
        await message.delete();
        event = { type: "batch", attempted: 1, deleted: 1, skipped: 0, failed: 0 };
      }
    } catch {
      event = { type: "batch", attempted: 1, deleted: 0, skipped: 0, failed: 1 };
    }
    state = transition(state, event);
    if (state.attempted === state.total || state.attempted % 10 === 0) {
      await interaction.editReply(progressCopy(state));
    }
  }
  state = transition(state, { type: "finish" });
  await interaction.editReply(progressCopy(state));
}
