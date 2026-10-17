# Discord.js TypeScript Bot Starter

Production-ready Discord bot boilerplate built with TypeScript and Discord.js v14+, adhering to [discord-bot-engineer](https://github.com/aphichat1835-coder/Skilldiscord-bot-engineer) architectural invariants.

## Features

- **TypeScript + ES Modules**: Clean compilation with `tsc` and hot-reloading with `tsx`.
- **Modern Discord Features**: Built-in User-Installable App support (`ApplicationIntegrationType.UserInstall` & `InteractionContextType`).
- **Single Acknowledgement Invariant**: Safe interaction execution preventing timeout, duplicate response, or uncaught rejection bugs.
- **Graceful Lifecycle**: Proper `SIGINT` / `SIGTERM` cleanup with client teardown.
- **Docker Ready**: Multi-stage lightweight Alpine Dockerfile and Docker Compose setup.

## Quick Start

1. Copy `.env.example` to `.env` and fill in credentials:
   ```bash
   cp .env.example .env
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start development server:
   ```bash
   npm run dev
   ```
4. Build for production:
   ```bash
   npm run build
   npm start
   ```
