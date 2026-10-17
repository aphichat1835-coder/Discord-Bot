export function createChallenge({ nonce, actorId, guildId, expiresAt }) {
  if (!nonce || !actorId || !guildId || !Number.isInteger(expiresAt)) throw new TypeError('nonce, actorId, guildId, and integer expiresAt are required');
  return Object.freeze({ nonce, actorId, guildId, expiresAt, consumedAt: null });
}

export function consumeChallenge(challenge, { actorId, guildId, now }) {
  if (challenge.consumedAt !== null) throw new Error('verification challenge was already consumed');
  if (challenge.actorId !== actorId || challenge.guildId !== guildId) throw new Error('verification challenge identity mismatch');
  if (now > challenge.expiresAt) throw new Error('verification challenge expired');
  return Object.freeze({ ...challenge, consumedAt: now });
}
