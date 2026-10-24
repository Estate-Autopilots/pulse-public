import unittest

from seed_editor_account_links import (
    normalized_email,
    outcome_counts,
    plan_links,
    staging_connection_allowed,
)


class EditorAccountSeedTests(unittest.TestCase):
    def test_staging_connection_guard_requires_staging_database_and_role(self):
        self.assertTrue(staging_connection_allowed("pulse_staging", "pulse_staging_owner"))
        self.assertFalse(staging_connection_allowed("pulse", "pulse_staging_owner"))
        self.assertFalse(staging_connection_allowed("pulse_staging", "pulse_owner"))

    def test_exact_directory_and_unique_person_match_is_planned(self):
        candidates = [{"account_id": "account-a", "handle": " editor-a@example.test ", "holder_person_id": None}]
        links, directory_matches, already_linked = plan_links(
            candidates,
            {"editor-a@example.test"},
            {"editor-a@example.test": ["person-a"]},
        )
        self.assertEqual(links, [{"account_id": "account-a", "handle": "editor-a@example.test", "person_id": "person-a"}])
        self.assertEqual((directory_matches, already_linked), (1, 0))

    def test_ambiguous_or_missing_evidence_is_not_planned(self):
        candidates = [
            {"account_id": "account-a", "handle": "editor-a@example.test", "holder_person_id": None},
            {"account_id": "account-b", "handle": "editor-b@example.test", "holder_person_id": None},
        ]
        links, directory_matches, already_linked = plan_links(
            candidates,
            {"editor-a@example.test"},
            {"editor-a@example.test": ["person-a", "person-b"]},
        )
        self.assertEqual(links, [])
        self.assertEqual((directory_matches, already_linked), (1, 0))

    def test_existing_matching_link_is_idempotent(self):
        candidates = [{"account_id": "account-a", "handle": "editor-a@example.test", "holder_person_id": "person-a"}]
        links, directory_matches, already_linked = plan_links(
            candidates,
            {"editor-a@example.test"},
            {"editor-a@example.test": ["person-a"]},
        )
        self.assertEqual(links, [])
        self.assertEqual((directory_matches, already_linked), (1, 1))

    def test_partial_dry_run_reports_pending_and_refused_counts(self):
        self.assertEqual(
            outcome_counts(candidate_count=3, directory_matches=2, planned_links=1,
                           already_linked=1, linked=0),
            {"candidates": 3, "directory_matches": 2, "linked": 0,
             "already_linked": 1, "refused": 1, "pending": 1},
        )

    def test_applied_counts_report_new_links(self):
        self.assertEqual(
            outcome_counts(candidate_count=3, directory_matches=2, planned_links=1,
                           already_linked=1, linked=1),
            {"candidates": 3, "directory_matches": 2, "linked": 1,
             "already_linked": 1, "refused": 1, "pending": 0},
        )

    def test_email_normalization_is_only_case_and_space(self):
        self.assertEqual(normalized_email(" Editor-A@Example.Test "), "editor-a@example.test")


if __name__ == "__main__":
    unittest.main()
