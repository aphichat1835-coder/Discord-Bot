# Modern Discord Features and Invariants

## Contents

- User-Installable Apps (Integration Types & Contexts)
- Discord Activities & Embedded App SDK
- AutoMod Architecture
- Components V2 & Rich Interactions

---

## User-Installable Apps (Integration Types & Contexts)

Discord supports installing apps directly to user profiles, allowing commands to run in any server, Group DM, or Direct Message—even where the bot is not a member of the guild.

### Key Enums & Configuration

1. **Integration Types** (`integration_types`):
   - `0` (`GUILD_INSTALL`): Traditional bot installation into a guild by a server admin.
   - `1` (`USER_INSTALL`): App installed directly to a user's account.

2. **Interaction Contexts** (`contexts`):
   - `0` (`GUILD`): Allowed in Discord servers.
   - `1` (`BOT_DM`): Allowed in direct messages with the bot.
   - `2` (`PRIVATE_CHANNEL`): Allowed in group DMs and DMs between users.

### Usage and Configuration

User Apps allow bots to be executed across servers, DMs, and group chats without requiring the bot to be invited into the guild.

---

## Discord Activities & Embedded App SDK

Discord Activities run web applications inside an iframe within Discord Voice Channels, utilizing `@discord/embedded-app-sdk`.

### Lifecycle and Integration

- **CSP & Frame Ancestors**: Activity frontend servers declare Content Security Policy (CSP):
  ```http
  Content-Security-Policy: frame-ancestors https://discord.com https://*.discord.com;
  ```
- **Voice State & Participant Lifecycle**: Track participant joins and leaves via voice state updates (`voiceStateUpdate`). Tear down active game/activity sessions and clean up allocated backend state when all participants leave.
- **State Synchronization**: WebSocket or state channels between activity clients synchronize states tied to the active voice session.

---

## AutoMod Architecture

Automated Moderation (AutoMod) rules enforce content policies natively at the Discord gateway.

### Capabilities and Actions

- **Audit Attribution**: All automated moderation actions (deleting messages, sending alerts, issuing timeouts) include clear audit log reason metadata attributing the triggering rule.
- **Rule Limits**: Guilds have limits on active AutoMod rules per trigger type. Verify rule count capacity before creating new rules programmatically.

---

## Components V2 & Dynamic Interfaces

- **State Preservation**: Component callbacks must survive process restarts by serializing state identifiers inside `custom_id` payloads or storing them in a persistent cache with strict TTL.
- **Single Owner Invariant**: Action rows containing sensitive operations (confirmations, payments, ticket closure) must bind to the original actor ID and reject interaction attempts from third-party users with an ephemeral warning.
