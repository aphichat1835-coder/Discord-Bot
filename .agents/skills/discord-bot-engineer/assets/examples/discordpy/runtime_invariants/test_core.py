import unittest

from assets.examples.discordpy.runtime_invariants.core import PlayerSession, apply_entitlement_event, claim_job, consume_oauth_state


class RuntimeInvariantTests(unittest.TestCase):
    def test_oauth_state(self):
        record = {"digest": "d", "session_id": "s", "expires_at": 20, "used_at": None}
        self.assertEqual(consume_oauth_state(record, state="d", session_id="wrong", now=10)["reason"], "wrong_session")
        self.assertTrue(consume_oauth_state(record, state="d", session_id="s", now=10)["ok"])
        self.assertEqual(consume_oauth_state(record, state="d", session_id="s", now=11)["reason"], "replayed")

    def test_player_cleanup(self):
        player = PlayerSession("g")
        player.start("track")
        self.assertEqual(player.fail("media error")["reason"], "media error")
        self.assertIsNone(player.track)
        player.destroy()
        self.assertEqual(player.start("late")["reason"], "destroyed")

    def test_job_fencing(self):
        job = {"generation": 0, "lease_until": 0, "owner_id": None, "completed_at": None}
        self.assertTrue(claim_job(job, worker_id="a", generation=1, now=10, lease_ms=10)["ok"])
        self.assertEqual(claim_job(job, worker_id="b", generation=2, now=11, lease_ms=10)["reason"], "leased")
        self.assertEqual(claim_job(job, worker_id="b", generation=1, now=21, lease_ms=10)["reason"], "stale_generation")

    def test_entitlement_ordering(self):
        store = {"events": set(), "entitlements": {}}
        grant = {"id": "e1", "entitlement_id": "p1", "owner_id": "u", "kind": "grant", "sequence": 1}
        self.assertTrue(apply_entitlement_event(store, grant)["entitlement"]["active"])
        self.assertTrue(apply_entitlement_event(store, grant)["duplicate"])
        self.assertEqual(apply_entitlement_event(store, {**grant, "id": "old", "kind": "revoke", "sequence": 0})["reason"], "out_of_order")


if __name__ == "__main__":
    unittest.main()
