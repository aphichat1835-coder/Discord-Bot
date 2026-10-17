from pathlib import Path
import importlib.util
import sys
import unittest

SPEC = importlib.util.spec_from_file_location("verification_core", Path(__file__).with_name("core.py"))
assert SPEC and SPEC.loader
CORE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CORE
SPEC.loader.exec_module(CORE)


class ChallengeTests(unittest.TestCase):
    def test_identity_expiry_and_replay(self) -> None:
        challenge = CORE.Challenge("secure-random", 1, 2, 100)
        with self.assertRaisesRegex(ValueError, "identity"):
            CORE.consume(challenge, actor_id=9, guild_id=2, now=50)
        consumed = CORE.consume(challenge, actor_id=1, guild_id=2, now=50)
        with self.assertRaisesRegex(ValueError, "already"):
            CORE.consume(consumed, actor_id=1, guild_id=2, now=51)
        with self.assertRaisesRegex(ValueError, "expired"):
            CORE.consume(CORE.Challenge("secure-random", 1, 2, 100), actor_id=1, guild_id=2, now=101)


if __name__ == "__main__":
    unittest.main()
