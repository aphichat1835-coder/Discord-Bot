import asyncio
import logging
import os
import signal
import sys
import discord
from discord.ext import commands
from dotenv import load_dotenv

load_dotenv()

TOKEN = os.getenv("DISCORD_TOKEN")
GUILD_ID = os.getenv("GUILD_ID")

if not TOKEN:
    print("❌ Error: DISCORD_TOKEN is not set in environment.", file=sys.stderr)
    sys.exit(1)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("bot")

class MyBot(commands.Bot):
    def __init__(self):
        # Bounded intents: Only request what is strictly needed
        intents = discord.Intents.default()
        super().__init__(command_prefix="!", intents=intents)

    async def setup_hook(self):
        # Load extensions/cogs
        await self.load_extension("cogs.general")
        await self.load_extension("cogs.error_handler")

        # Sync app commands
        if GUILD_ID:
            guild_obj = discord.Object(id=int(GUILD_ID))
            self.tree.copy_global_to(guild=guild_obj)
            synced = await self.tree.sync(guild=guild_obj)
            logger.info("📡 Synced %d command(s) to guild %s", len(synced), GUILD_ID)
        else:
            synced = await self.tree.sync()
            logger.info("📡 Synced %d global command(s)", len(synced))

    async def on_ready(self):
        logger.info("✅ Logged in as %s (ID: %s)", self.user, self.user.id)

async def main():
    bot = MyBot()

    loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()

    def handle_signal(sig):
        logger.info("🛑 Received signal %s. Initiating graceful shutdown...", sig.name)
        stop_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, lambda s=sig: handle_signal(s))

    async with bot:
        bot_task = asyncio.create_task(bot.start(TOKEN))
        await stop_event.wait()
        logger.info("Closing bot session...")
        await bot.close()
        await bot_task

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        pass
