from dataclasses import dataclass, replace


@dataclass(frozen=True)
class Challenge:
    nonce: str
    actor_id: int
    guild_id: int
    expires_at: int
    consumed_at: int | None = None


def consume(challenge: Challenge, *, actor_id: int, guild_id: int, now: int) -> Challenge:
    if challenge.consumed_at is not None:
        raise ValueError("verification challenge was already consumed")
    if challenge.actor_id != actor_id or challenge.guild_id != guild_id:
        raise ValueError("verification challenge identity mismatch")
    if now > challenge.expires_at:
        raise ValueError("verification challenge expired")
    return replace(challenge, consumed_at=now)
