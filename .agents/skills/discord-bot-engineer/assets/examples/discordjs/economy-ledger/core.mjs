export function transfer(state, { idempotencyKey, from, to, amount }) {
  if (!idempotencyKey || from === to || !Number.isSafeInteger(amount) || amount <= 0) throw new TypeError('valid transfer identity and positive integer amount are required');
  if (state.appliedKeys.includes(idempotencyKey)) throw new Error('duplicate idempotency key');
  const fromBalance = state.balances[from] ?? 0;
  const toBalance = state.balances[to] ?? 0;
  if (!Object.values(state.balances).every(Number.isSafeInteger)) throw new TypeError('balances must contain exact safe integer amounts');
  if (fromBalance < amount) throw new Error('insufficient balance');
  const before = Object.values(state.balances).reduce((sum, value) => sum + value, 0);
  const balances = { ...state.balances, [from]: fromBalance - amount, [to]: toBalance + amount };
  if (!Object.values(balances).every(Number.isSafeInteger)) throw new RangeError('resulting balance exceeds safe integer range');
  const after = Object.values(balances).reduce((sum, value) => sum + value, 0);
  if (before !== after) throw new Error('currency conservation invariant violated');
  const entry = Object.freeze({ idempotencyKey, from, to, amount });
  return Object.freeze({ balances: Object.freeze(balances), appliedKeys: Object.freeze([...state.appliedKeys, idempotencyKey]), ledger: Object.freeze([...state.ledger, entry]) });
}
