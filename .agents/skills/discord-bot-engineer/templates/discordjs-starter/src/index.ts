import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import { config } from './config.js';
import * as pingCommand from './commands/ping.js';
import * as interactionCreateEvent from './events/interactionCreate.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
  ],
});

client.once('ready', async (readyClient) => {
  console.log(`✅ Logged in as ${readyClient.user.tag}`);

  // Register slash commands
  const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);
  try {
    const commands = [pingCommand.data.toJSON()];
    if (config.GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(config.CLIENT_ID, config.GUILD_ID),
        { body: commands }
      );
      console.log(`📡 Registered commands to guild: ${config.GUILD_ID}`);
    } else {
      await rest.put(
        Routes.applicationCommands(config.CLIENT_ID),
        { body: commands }
      );
      console.log('📡 Registered global application commands');
    }
  } catch (error) {
    console.error('❌ Failed to register application commands:', error);
  }
});

client.on(interactionCreateEvent.name, interactionCreateEvent.execute);

async function shutdown(signal: string) {
  console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(config.DISCORD_TOKEN).catch((err) => {
  console.error('❌ Failed to login:', err);
  process.exit(1);
});
