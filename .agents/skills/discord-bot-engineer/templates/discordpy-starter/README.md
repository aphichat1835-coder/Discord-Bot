# Discord.py Bot Starter

Production-ready Discord bot boilerplate built with Python and discord.py 2.4+, adhering to [discord-bot-engineer](https://github.com/aphichat1835-coder/Skilldiscord-bot-engineer) architectural invariants.

## Features

- **Modern Discord Features**: Full User-Installable App support (`@app_commands.user_install()`, `@app_commands.guild_install()`, `@app_commands.allowed_contexts()`).
- **Modular Cog Architecture**: Structured cogs with setup hooks for commands and error handling.
- **Graceful Lifecycle**: Proper `SIGINT` / `SIGTERM` handling via `asyncio.Event` ensuring clean websocket session closure without unclosed client sessions.
- **Unified App Command Error Handling**: Ephemeral error feedback covering cooldowns, missing permissions, and unhandled errors.
- **Docker Ready**: Lightweight Python 3.11 slim Dockerfile and Docker Compose setup.

## Quick Start

1. Copy `.env.example` to `.env` and fill in credentials:
   ```bash
   cp .env.example .env
   ```
2. Create and activate a virtual environment:
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   ```
3. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
4. Run the bot:
   ```bash
   python main.py
   ```
