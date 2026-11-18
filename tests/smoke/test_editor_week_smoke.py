import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tools.editor_week_smoke import aggregate_editor_week


WEEK = "2026-W40"
PERSON_A = "10000000-0000-0000-0000-000000000001"
PERSON_B = "10000000-0000-0000-0000-000000000002"


def editor_week(drafts, finals, target=2, gap=0):
    return {
        "week": WEEK,
        "types": {
            kind: {
                "target": target if kind == "model_video" else None,
                "delivered": {"drafts": drafts if kind == "model_video" else 0,
                              "finals": finals if kind == "model_video" else 0},
                "gap": gap if kind == "model_video" else None,
            }
            for kind in ("model_video", "vov", "founder_video", "testimonial", "walkthrough", "other")
        },
    }


class EditorWeekSmokeTests(unittest.TestCase):
    def test_receipt_aggregates_only_verified_non_shared_rows(self):
        accounts = [
            {"account": "private-a@example.test", "holder_person_id": PERSON_A,
             "identityVerified": True, "sharedLogin": False, "thisWeek": 2},
            {"account": "private-b@example.test", "holder_person_id": PERSON_B,
             "identityVerified": True, "sharedLogin": False, "thisWeek": 1},
            {"account": "shared@example.test", "holder_person_id": None,
             "identityVerified": False, "sharedLogin": True, "thisWeek": 9},
        ]
        weekly = {PERSON_A: editor_week(1, 1), PERSON_B: editor_week(0, 1, target=3, gap=2)}
        receipt = aggregate_editor_week(accounts, WEEK, weekly.__getitem__)

        self.assertEqual(receipt["rows_compared"], 2)
        self.assertEqual(receipt["rows_matched"], 2)
        self.assertEqual(receipt["delivered_total"], 3)
        self.assertEqual(receipt["by_type"]["model_video"], {
            "target_total": 5, "targets_configured": 2, "drafts": 1, "finals": 2,
            "gap_total": 2, "gaps_available": 2,
        })
        serialized = str(receipt)
        self.assertNotIn("private-a", serialized)
        self.assertNotIn(PERSON_A, serialized)

    def test_weekly_count_mismatch_fails_without_personal_context(self):
        accounts = [{"account": "private@example.test", "holder_person_id": PERSON_A,
                     "identityVerified": True, "sharedLogin": False, "thisWeek": 4}]
        with self.assertRaisesRegex(ValueError, "does not match creative-type"):
            aggregate_editor_week(accounts, WEEK, lambda _person: editor_week(1, 1))


if __name__ == "__main__":
    unittest.main()
