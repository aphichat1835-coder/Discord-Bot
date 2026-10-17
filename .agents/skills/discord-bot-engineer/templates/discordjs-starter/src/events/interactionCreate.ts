import { Interaction, Events } from 'discord.js';
import * as pingCommand from '../commands/ping.js';

export const name = Events.InteractionCreate;

export async function execute(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === pingCommand.data.name) {
    try {
      await pingCommand.execute(interaction);
    } catch (error) {
      console.error(`[CommandError] ${interaction.commandName}:`, error);

      const errorMessage = '⚠️ An error occurred while executing this command.';
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: errorMessage, ephemeral: true }).catch(() => {});
      } else {
        await interaction.reply({ content: errorMessage, ephemeral: true }).catch(() => {});
      }
    }
  }
}
