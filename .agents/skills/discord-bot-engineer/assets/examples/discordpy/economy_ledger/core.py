from dataclasses import dataclass


@dataclass(frozen=True)
class Entry:
    idempotency_key: str
    sender: str
    recipient: str
    amount: int


def transfer(state: dict, *, idempotency_key: str, sender: str, recipient: str, amount: int) -> dict:
    if not idempotency_key or sender == recipient or not isinstance(amount, int) or isinstance(amount, bool) or amount <= 0:
        raise ValueError("valid transfer identity and positive integer amount are required")
    if idempotency_key in state["applied_keys"]:
        raise ValueError("duplicate idempotency key")
    balances = dict(state["balances"])
    if any(not isinstance(value, int) or isinstance(value, bool) for value in balances.values()):
        raise ValueError("balances must contain exact integer amounts")
    if balances.get(sender, 0) < amount:
        raise ValueError("insufficient balance")
    before = sum(balances.values())
    balances[sender] -= amount
    balances[recipient] = balances.get(recipient, 0) + amount
    if sum(balances.values()) != before:
        raise ValueError("currency conservation invariant violated")
    return {"balances": balances, "applied_keys": [*state["applied_keys"], idempotency_key], "ledger": [*state["ledger"], Entry(idempotency_key, sender, recipient, amount)]}
