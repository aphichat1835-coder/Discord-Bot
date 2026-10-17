import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeChallenge, createChallenge } from './core.mjs';

test('binds challenge to actor and prevents replay', () => {
  const challenge = createChallenge({ nonce: 'random-from-secure-source', actorId: '1', guildId: '2', expiresAt: 100 });
  assert.throws(() => consumeChallenge(challenge, { actorId: '9', guildId: '2', now: 50 }), /identity/);
  const consumed = consumeChallenge(challenge, { actorId: '1', guildId: '2', now: 50 });
  assert.throws(() => consumeChallenge(consumed, { actorId: '1', guildId: '2', now: 51 }), /already/);
});

test('rejects expired challenge', () => {
  const challenge = createChallenge({ nonce: 'random-from-secure-source', actorId: '1', guildId: '2', expiresAt: 100 });
  assert.throws(() => consumeChallenge(challenge, { actorId: '1', guildId: '2', now: 101 }), /expired/);
});
