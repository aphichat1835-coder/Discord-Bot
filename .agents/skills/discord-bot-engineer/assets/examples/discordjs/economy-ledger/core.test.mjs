import test from 'node:test';
import assert from 'node:assert/strict';
import { transfer } from './core.mjs';

test('preserves currency and rejects duplicate transfer', () => {
  const initial = { balances: { a: 10, b: 2 }, appliedKeys: [], ledger: [] };
  const next = transfer(initial, { idempotencyKey: 'interaction-1', from: 'a', to: 'b', amount: 4 });
  assert.deepEqual(next.balances, { a: 6, b: 6 });
  assert.throws(() => transfer(next, { idempotencyKey: 'interaction-1', from: 'a', to: 'b', amount: 4 }), /duplicate/);
});

test('rejects overdraft', () => {
  assert.throws(() => transfer({ balances: { a: 1, b: 0 }, appliedKeys: [], ledger: [] }, { idempotencyKey: 'x', from: 'a', to: 'b', amount: 2 }), /insufficient/);
});
