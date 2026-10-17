import time
import discord
from discord import app_commands
from discord.ext import commands

class General(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @app_commands.command(name="ping", description="Replies with bot latency and WebSocket ping.")
    @app_commands.guild_install()
    @app_commands.user_install()
    @app_commands.allowed_contexts(guilds=True, dms=True, private_channels=True)
    async def ping(self, interaction: discord.Interaction):
        start_time = time.monotonic()
        await interaction.response.send_message("Pinging...")

        end_time = time.monotonic()
        roundtrip_ms = round((end_time - start_time) * 1000)
        ws_ms = round(self.bot.latency * 1000)

        await interaction.edit_original_response(
            content=f"🏓 **Pong!**\n- Latency: `{roundtrip_ms}ms`\n- WebSocket: `{ws_ms}ms`"
        )

async def setup(bot: commands.Bot):
    await bot.add_cog(General(bot))
