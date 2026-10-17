/**
 * High-performance token authentication, token pool, and OAuth2 management for Discord bots (Node.js / ESM).
 */

const DISCORD_API_BASE = 'https://discord.com/api/v10';

export class TokenVerificationError extends Error {
  constructor(message, status = null, responseBody = null) {
    super(message);
    this.name = 'TokenVerificationError';
    this.status = status;
    this.responseBody = responseBody;
  }
}

export class DiscordTokenValidator {
  /**
   * Fast verification using Discord REST API directly (no gateway overhead).
   * @param {string} token
   * @param {'Bot' | 'Bearer'} tokenType
   * @returns {Promise<object>} User/Bot object
   */
  static async request(endpoint, token, tokenType = 'Bot') {
    const res = await fetch(`${DISCORD_API_BASE}${endpoint}`, {
      method: 'GET',
      headers: {
        Authorization: `${tokenType} ${token.trim()}`,
        'User-Agent': 'DiscordBotEngine/1.0',
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new TokenVerificationError(
        `Discord API error ${res.status}: ${res.statusText}`,
        res.status,
        errText
      );
    }

    return await res.json();
  }

  static async verifyBotToken(token) {
    return this.request('/users/@me', token, 'Bot');
  }

  static async verifyBearerToken(token) {
    return this.request('/users/@me', token, 'Bearer');
  }
}

export class DiscordOAuth2Manager {
  constructor({ clientId, clientSecret, redirectUri }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
  }

  async #postToken(params) {
    const body = new URLSearchParams(params);
    const res = await fetch(`${DISCORD_API_BASE}/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'DiscordBotEngine/1.0',
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new TokenVerificationError(`OAuth2 Token error: ${res.status}`, res.status, errText);
    }

    return await res.json();
  }

  async exchangeCode(code) {
    return this.#postToken({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
    });
  }

  async refreshAccessToken(refreshToken) {
    return this.#postToken({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  }

  async fetchUserInfo(accessToken) {
    return DiscordTokenValidator.verifyBearerToken(accessToken);
  }

  async fetchUserGuilds(accessToken) {
    const res = await fetch(`${DISCORD_API_BASE}/users/@me/guilds`, {
      headers: {
        Authorization: `Bearer ${accessToken.trim()}`,
        'User-Agent': 'DiscordBotEngine/1.0',
      },
    });
    if (!res.ok) {
      throw new TokenVerificationError(`Guild fetch failed: ${res.status}`, res.status, await res.text());
    }
    return await res.json();
  }
}

export class TokenPool {
  /**
   * @param {string[]} tokens
   */
  constructor(tokens = []) {
    this.tokens = tokens.map((t) => t.trim()).filter(Boolean);
    this.index = 0;
    this.backoffs = new Map();
  }

  addToken(token) {
    const clean = token.trim();
    if (clean && !this.tokens.includes(clean)) {
      this.tokens.push(clean);
    }
  }

  markRateLimited(token, retryAfterMs) {
    this.backoffs.set(token, Date.now() + retryAfterMs);
  }

  async getNextAvailableToken() {
    if (this.tokens.length === 0) {
      throw new Error('TokenPool is empty.');
    }

    const now = Date.now();
    for (let i = 0; i < this.tokens.length; i++) {
      const candidate = this.tokens[this.index % this.tokens.length];
      this.index++;
      const backoffUntil = this.backoffs.get(candidate) || 0;
      if (now >= backoffUntil) {
        return candidate;
      }
    }

    // All currently rate-limited; wait for earliest release
    const minWait = Math.min(...Array.from(this.backoffs.values())) - now;
    if (minWait > 0) {
      await new Promise((resolve) => setTimeout(resolve, minWait));
    }
    return this.tokens[this.index % this.tokens.length];
  }
}
