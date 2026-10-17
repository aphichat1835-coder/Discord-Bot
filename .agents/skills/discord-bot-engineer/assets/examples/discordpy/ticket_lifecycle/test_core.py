import unittest

from assets.examples.discordpy.ticket_lifecycle.core import TicketLifecycle


class TicketLifecycleTests(unittest.TestCase):
    def test_duplicate_and_serialized_close(self):
        tickets = TicketLifecycle()
        self.assertTrue(tickets.open("g", "u", "c")["ok"])
        self.assertEqual(tickets.open("g", "u", "c2")["reason"], "already_open")
        self.assertTrue(tickets.begin_close("g", "u")["ok"])
        self.assertEqual(tickets.begin_close("g", "u")["reason"], "close_in_progress")
        self.assertEqual(tickets.finish_close("g", "u", "ref:1")["ticket"]["state"], "closed")

    def test_partial_close_recovery(self):
        tickets = TicketLifecycle()
        tickets.open("g", "u", "c")
        tickets.begin_close("g", "u")
        self.assertEqual(tickets.recover_close("g", "u", "upload failed")["ticket"]["state"], "open")


if __name__ == "__main__":
    unittest.main()
