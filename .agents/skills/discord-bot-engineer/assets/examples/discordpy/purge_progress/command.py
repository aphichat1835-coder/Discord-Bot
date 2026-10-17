from __future__ import annotations

import discord
from discord import app_commands

from .core import PurgeState, account, finish, progress_copy, start


@app_commands.command(name="purge", description="ลบข้อความพร้อมรายงานผลตามจริง")
@app_commands.checks.has_permissions(manage_messages=True)
async def purge(interaction: discord.Interaction, amount: app_commands.Range[int, 1, 100]) -> None:
    await interaction.response.defer(ephemeral=True)
    channel = interaction.channel
    if not isinstance(channel, discord.TextChannel):
        await interaction.edit_original_response(content="คำสั่งนี้ใช้ได้เฉพาะห้องข้อความ")
        return
    selected = [message async for message in channel.history(limit=amount)]
    state = start(PurgeState(actor_id=interaction.user.id, total=len(selected)))
    await interaction.edit_original_response(content=progress_copy(state))
    for message in selected:
        try:
            await message.delete()
            state = account(state, attempted=1, deleted=1, skipped=0, failed=0)
        except discord.Forbidden:
            state = account(state, attempted=1, deleted=0, skipped=1, failed=0)
        except discord.HTTPException:
            state = account(state, attempted=1, deleted=0, skipped=0, failed=1)
        if state.attempted == state.total or state.attempted % 10 == 0:
            await interaction.edit_original_response(content=progress_copy(state))
    await interaction.edit_original_response(content=progress_copy(finish(state)))
