import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  InteractionContextType,
  ApplicationIntegrationType,
} from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Replies with bot latency and WebSocket ping.')
  // Modern Discord features: Usable anywhere (User App & Guild App)
  .setIntegrationTypes([
    ApplicationIntegrationType.GuildInstall,
    ApplicationIntegrationType.UserInstall,
  ])
  .setContexts([
    InteractionContextType.Guild,
    InteractionContextType.BotDM,
    InteractionContextType.PrivateChannel,
  ]);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sent = await interaction.reply({
    content: 'Pinging...',
    fetchReply: true,
  });

  const roundtrip = sent.createdTimestamp - interaction.createdTimestamp;
  const wsPing = interaction.client.ws.ping;

  await interaction.editReply({
    content: `🏓 **Pong!**\n- Latency: \`${roundtrip}ms\`\n- WebSocket: \`${wsPing}ms\``,
  });
}
