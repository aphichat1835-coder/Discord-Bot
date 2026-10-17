from pathlib import Path
import importlib.util
import sys
import unittest


SPEC = importlib.util.spec_from_file_location("purge_core", Path(__file__).with_name("core.py"))
assert SPEC and SPEC.loader
CORE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CORE
SPEC.loader.exec_module(CORE)


class PurgeStateTests(unittest.TestCase):
    def test_rejects_fractional_counts(self) -> None:
        with self.assertRaises(ValueError):
            CORE.PurgeState(actor_id=1, total=1.5)
        state = CORE.start(CORE.PurgeState(actor_id=1, total=1))
        with self.assertRaises(ValueError):
            CORE.account(state, attempted=0.5, deleted=0.5, skipped=0, failed=0)

    def test_partial_and_terminal(self) -> None:
        state = CORE.start(CORE.PurgeState(actor_id=1, total=2))
        state = CORE.account(state, attempted=1, deleted=1, skipped=0, failed=0)
        state = CORE.account(state, attempted=1, deleted=0, skipped=0, failed=1)
        state = CORE.finish(state)
        self.assertEqual(state.phase, "partial")
        with self.assertRaises(RuntimeError):
            CORE.start(state)

    def test_rejects_false_accounting(self) -> None:
        state = CORE.start(CORE.PurgeState(actor_id=1, total=1))
        with self.assertRaises(ValueError):
            CORE.account(state, attempted=1, deleted=1, skipped=1, failed=0)


if __name__ == "__main__":
    unittest.main()
