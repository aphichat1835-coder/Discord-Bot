import logging
import discord
from discord import app_commands
from discord.ext import commands

logger = logging.getLogger(__name__)

class CommandErrorHandler(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        bot.tree.on_error = self.on_app_command_error

    async def on_app_command_error(
        self,
        interaction: discord.Interaction,
        error: app_commands.AppCommandError
    ):
        if isinstance(error, app_commands.CommandOnCooldown):
            message = f"⏳ Please wait {error.retry_after:.1f}s before reusing this command."
        elif isinstance(error, app_commands.MissingPermissions):
            perms = ", ".join(error.missing_permissions)
            message = f"🚫 You lack the required permission(s): `{perms}`."
        elif isinstance(error, app_commands.BotMissingPermissions):
            perms = ", ".join(error.missing_permissions)
            message = f"⚠️ The bot lacks permission(s): `{perms}`."
        else:
            logger.error("Unhandled app command error: %s", error, exc_info=True)
            message = "⚠️ An unexpected error occurred while executing this command."

        if interaction.response.is_done():
            await interaction.followup.send(message, ephemeral=True)
        else:
            await interaction.response.send_message(message, ephemeral=True)

async def setup(bot: commands.Bot):
    await bot.add_cog(CommandErrorHandler(bot))
