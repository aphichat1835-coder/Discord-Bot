"""High-performance token authentication, token pool, and OAuth2 management for Discord bots.

Supports:
- Zero-gateway token verification & identity extraction
- Token Pool with health tracking and rotation
- Automatic Discord 429 rate limit backoff
- OAuth2 authorization code exchange & token refresh
- Multi-client bot login and lifecycle orchestration
"""

from __future__ import annotations

import asyncio
import itertools
import json
import logging
import time
from typing import Any, Dict, List, Optional
import urllib.parse
import urllib.request
import urllib.error

logger = logging.getLogger("discord_token_manager")
DISCORD_API_BASE = "https://discord.com/api/v10"


class TokenVerificationError(Exception):
    """Raised when token authentication fails."""


class DiscordTokenValidator:
    """Fast, lightweight token validator using direct REST API requests."""

    @staticmethod
    def _request(
        endpoint: str,
        token: str,
        token_type: str = "Bot",
        timeout: float = 10.0,
    ) -> Dict[str, Any]:
        url = f"{DISCORD_API_BASE}{endpoint}"
        req = urllib.request.Request(
            url,
            headers={
                "Authorization": f"{token_type} {token.strip()}",
                "User-Agent": "DiscordBotEngine/1.0",
            },
            method="GET",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                status = response.getcode()
                body = response.read().decode("utf-8")
                return json.loads(body)
        except urllib.error.HTTPError as err:
            err_body = err.read().decode("utf-8", errors="replace")
            raise TokenVerificationError(
                f"HTTP {err.code}: {err.reason} - {err_body}"
            ) from err
        except Exception as err:
            raise TokenVerificationError(f"Connection failed: {err}") from err

    @classmethod
    def verify_bot_token(cls, token: str, timeout: float = 10.0) -> Dict[str, Any]:
        """Verify bot token and return bot user object (id, username, avatar, flags)."""
        return cls._request("/users/@me", token, token_type="Bot", timeout=timeout)

    @classmethod
    def verify_bearer_token(cls, token: str, timeout: float = 10.0) -> Dict[str, Any]:
        """Verify OAuth2 Bearer token and return user profile."""
        return cls._request("/users/@me", token, token_type="Bearer", timeout=timeout)


class DiscordOAuth2Manager:
    """Manages OAuth2 access tokens, refresh tokens, and user data retrieval."""

    def __init__(self, client_id: str, client_secret: str, redirect_uri: str):
        self.client_id = client_id
        self.client_secret = client_secret
        self.redirect_uri = redirect_uri

    def _post_token(self, data: Dict[str, str]) -> Dict[str, Any]:
        url = f"{DISCORD_API_BASE}/oauth2/token"
        encoded = urllib.parse.urlencode(data).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=encoded,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "DiscordBotEngine/1.0",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=15.0) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            err_body = err.read().decode("utf-8", errors="replace")
            raise TokenVerificationError(f"OAuth token error {err.code}: {err_body}") from err

    def exchange_code(self, code: str) -> Dict[str, Any]:
        """Exchange authorization code for access_token, refresh_token, and scope."""
        return self._post_token({
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": self.redirect_uri,
        })

    def refresh_access_token(self, refresh_token: str) -> Dict[str, Any]:
        """Use refresh_token to acquire a fresh access_token."""
        return self._post_token({
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        })

    def fetch_user_info(self, access_token: str) -> Dict[str, Any]:
        """Fetch user profile with OAuth2 Bearer token."""
        return DiscordTokenValidator.verify_bearer_token(access_token)

    def fetch_user_guilds(self, access_token: str) -> List[Dict[str, Any]]:
        """Fetch guilds that the authenticated user belongs to."""
        url = f"{DISCORD_API_BASE}/users/@me/guilds"
        req = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {access_token.strip()}",
                "User-Agent": "DiscordBotEngine/1.0",
            },
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=15.0) as response:
            return json.loads(response.read().decode("utf-8"))


class TokenPool:
    """High-throughput token pool with health checks, rate limit backoff, and round-robin."""

    def __init__(self, tokens: List[str]):
        self.tokens = [t.strip() for t in tokens if t.strip()]
        self._cycler = itertools.cycle(self.tokens) if self.tokens else None
        self._lock = asyncio.Lock()
        self._backoffs: Dict[str, float] = {}

    def add_token(self, token: str) -> None:
        token = token.strip()
        if token and token not in self.tokens:
            self.tokens.append(token)
            self._cycler = itertools.cycle(self.tokens)

    def mark_rate_limited(self, token: str, retry_after: float) -> None:
        """Mark a token as temporarily rate-limited with expiry timestamp."""
        self._backoffs[token] = time.time() + retry_after
        logger.warning("Token %s... rate limited for %.2fs", token[:10], retry_after)

    async def get_next_available_token(self) -> str:
        """Get next valid, non-rate-limited token using round-robin."""
        if not self.tokens:
            raise ValueError("TokenPool is empty.")

        async with self._lock:
            now = time.time()
            for _ in range(len(self.tokens)):
                candidate = next(self._cycler)
                backoff_until = self._backoffs.get(candidate, 0.0)
                if now >= backoff_until:
                    return candidate

            # All tokens are backoff-limited; find minimum wait time
            min_wait = min(self._backoffs.values()) - now
            if min_wait > 0:
                await asyncio.sleep(min_wait)
            return next(self._cycler)
