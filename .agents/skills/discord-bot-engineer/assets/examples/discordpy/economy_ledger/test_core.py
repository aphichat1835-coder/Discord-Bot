from pathlib import Path
import importlib.util
import sys
import unittest

SPEC = importlib.util.spec_from_file_location("economy_core", Path(__file__).with_name("core.py"))
assert SPEC and SPEC.loader
CORE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CORE
SPEC.loader.exec_module(CORE)


class LedgerTests(unittest.TestCase):
    def test_rejects_boolean_amount(self) -> None:
        initial = {"balances": {"a": 2, "b": 0}, "applied_keys": [], "ledger": []}
        with self.assertRaises(ValueError):
            CORE.transfer(initial, idempotency_key="bool", sender="a", recipient="b", amount=True)

    def test_conservation_duplicate_and_overdraft(self) -> None:
        initial = {"balances": {"a": 10, "b": 2}, "applied_keys": [], "ledger": []}
        result = CORE.transfer(initial, idempotency_key="interaction-1", sender="a", recipient="b", amount=4)
        self.assertEqual(result["balances"], {"a": 6, "b": 6})
        with self.assertRaisesRegex(ValueError, "duplicate"):
            CORE.transfer(result, idempotency_key="interaction-1", sender="a", recipient="b", amount=4)
        with self.assertRaisesRegex(ValueError, "insufficient"):
            CORE.transfer(initial, idempotency_key="interaction-2", sender="a", recipient="b", amount=11)


if __name__ == "__main__":
    unittest.main()
