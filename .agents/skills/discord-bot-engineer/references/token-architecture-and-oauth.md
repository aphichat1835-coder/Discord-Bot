# High-Performance Token Architecture, OAuth2, and Multi-Bot Engineering

## Overview

This guide provides deep technical instructions for building high-speed Discord token validation, OAuth2 authorization pipelines, token pooling, and multi-bot client orchestration.

---

## 1. Low-Level REST Authentication Mechanics

Discord REST API operates on HTTP/2 and HTTP/1.1 over TLS. Direct REST queries provide maximum performance for verifying tokens and retrieving identity data without the latency of a full Gateway WebSocket handshake.

### Header Construction
- **Bot Token**: `Authorization: Bot <token>`
- **OAuth2 Bearer Token**: `Authorization: Bearer <access_token>`
- **User-Agent**: `DiscordBot (https://yourdomain.com, 1.0.0)` (Custom User-Agent ensures requests bypass aggressive edge throttling).

### Endpoint Reference for Rapid Verification
- **Identity & Metadata**: `GET https://discord.com/api/v10/users/@me`
  - Response time: ~40ms - 90ms (vs ~500ms for Gateway READY).
  - Returns: `id`, `username`, `discriminator`, `avatar`, `bot`, `flags`, `verified`.
- **Application & Bot Gateway Configuration**: `GET https://discord.com/api/v10/gateway/bot`
  - Returns: `url` (WebSocket gateway endpoint), `shards` (recommended shard count), `session_start_limit` (remaining daily identifies).

---

## 2. Writing Direct Token Verifiers from Scratch

When implementing without heavy framework dependencies:

### Python Implementation (Raw Asynchronous HTTP)
```python
import asyncio
import aiohttp

async def fetch_bot_identity(token: str) -> dict:
    url = "https://discord.com/api/v10/users/@me"
    headers = {
        "Authorization": f"Bot {token.strip()}",
        "User-Agent": "HighSpeedBotManager/2.0",
    }
    async with aiohttp.ClientSession() as session:
        async with session.get(url, headers=headers) as resp:
            if resp.status == 200:
                return await resp.json()
            error_body = await resp.text()
            raise RuntimeError(f"Token verification failed ({resp.status}): {error_body}")
```

### TypeScript / Node.js Implementation (Native Fetch)
```typescript
interface DiscordUser {
  id: string;
  username: string;
  avatar: string | null;
  bot?: boolean;
}

export async function verifyBotToken(token: string): Promise<DiscordUser> {
  const response = await fetch("https://discord.com/api/v10/users/@me", {
    method: "GET",
    headers: {
      Authorization: `Bot ${token.trim()}`,
      "User-Agent": "HighSpeedBotManager/2.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Invalid token response (${response.status}): ${await response.text()}`);
  }

  return (await response.json()) as DiscordUser;
}
```

---

## 3. End-to-End Discord OAuth2 Pipeline

The OAuth2 flow enables your system to obtain user-authorized access tokens to fetch user profiles, guilds, and identity data.

### Step 1: Generating the Authorization URL
Construct the redirect link:
```text
https://discord.com/oauth2/authorize?client_id={CLIENT_ID}&response_type=code&redirect_uri={ENCODED_REDIRECT_URI}&scope=identify%20guilds%20email
```

### Step 2: Code Exchange for Access & Refresh Tokens
POST to `https://discord.com/api/v10/oauth2/token`:
- **Content-Type**: `application/x-www-form-urlencoded`
- **Body parameters**:
  - `client_id`: Application ID
  - `client_secret`: Application Secret
  - `grant_type`: `authorization_code`
  - `code`: Code received from callback
  - `redirect_uri`: Exact matching redirect URI

**Response Structure**:
```json
{
  "access_token": "ACCESS_TOKEN_STRING",
  "token_type": "Bearer",
  "expires_in": 604800,
  "refresh_token": "REFRESH_TOKEN_STRING",
  "scope": "identify guilds"
}
```

### Step 3: Fetching User Profiles & Guilds
With the `access_token`, query with header `Authorization: Bearer <access_token>`:
1. **User Profile**: `GET https://discord.com/api/v10/users/@me`
2. **User Guilds**: `GET https://discord.com/api/v10/users/@me/guilds`

### Step 4: Refreshing Access Tokens
When `expires_in` approaches, exchange the `refresh_token` without prompting the user:
- `grant_type`: `refresh_token`
- `refresh_token`: Current refresh token
- `client_id` & `client_secret`

---

## 4. High-Throughput Token Pool Architecture

When serving heavy multi-tenant Discord applications, rotating requests across a pool of bot tokens maximizes throughput and eliminates bottlenecks.

### Round-Robin with Rate-Limit Awareness
1. **Token Registry**: Maintain an active list of verified tokens.
2. **Backoff Map**: Maintain a map of `token -> unblock_timestamp`.
3. **Dispatch Loop**:
   - Filter to tokens whose `unblock_timestamp <= now`.
   - Select next token via round-robin index.
   - If HTTP 429 is encountered, extract `Retry-After` header, record `now + retry_after`, and dispatch request using the next token in the pool.

---

## 5. Multi-Client Bot Orchestration

Running multiple bot instances concurrently in a single process.

### Python (discord.py Multi-Client Runner)
```python
import asyncio
from discord.ext import commands
import discord

async def start_bot(token: str, bot_id: int):
    intents = discord.Intents.default()
    bot = commands.Bot(command_prefix="!", intents=intents)

    @bot.event
    async def on_ready():
        print(f"Bot #{bot_id} ready as {bot.user}")

    async with bot:
        await bot.start(token)

async def run_cluster(tokens: list[str]):
    tasks = [
        asyncio.create_task(start_bot(token, idx))
        for idx, token in enumerate(tokens)
    ]
    await asyncio.gather(*tasks)
```

### TypeScript (discord.js Multi-Client Cluster)
```typescript
import { Client, GatewayIntentBits } from 'discord.js';

export class BotCluster {
  private clients: Client[] = [];

  constructor(private tokens: string[]) {}

  public async startAll(): Promise<void> {
    const promises = this.tokens.map((token, index) => {
      const client = new Client({ intents: [GatewayIntentBits.Guilds] });
      this.clients.push(client);

      client.once('ready', () => {
        console.log(`Cluster node #${index} logged in as ${client.user?.tag}`);
      });

      return client.login(token);
    });

    await Promise.all(promises);
  }

  public async stopAll(): Promise<void> {
    for (const client of this.clients) {
      client.destroy();
    }
  }
}
```

---

## 6. Rate Limit (429) Header Optimization

Discord embeds bucket and rate limit telemetry in response headers:
- `X-RateLimit-Limit`: Maximum requests permitted within the bucket period.
- `X-RateLimit-Remaining`: Count of remaining calls.
- `X-RateLimit-Reset-After`: Exact floating-point seconds until quota resets.
- `X-RateLimit-Bucket`: Unique route-bucket hash.
- `X-RateLimit-Global`: `true` if IP-wide rate limit triggered.

Always extract `X-RateLimit-Reset-After` when HTTP 429 occurs to pause exactly for the required duration rather than using arbitrary sleep intervals.
