"""Metadata roster and retained HR-source decisions, using synthetic names only."""
import uuid
from datetime import date

from pulse_gdrive_snapshot import roster as R

ORG = uuid.UUID("00000000-0000-0000-0000-0000000000aa")
CONFIG = {
    "team": [{"name": "Asha Rao", "key": "Asha R.", "role": "PGS", "pod": "Pod 1"},
             {"name": "Vikram Shah", "role": "Creative strategist", "pod": "Pod 2"}],
    "name_aliases": {"Asha Rao": ["Aasha Rao"]},
    "confirm_same_person": [{"name": "Vikram Shah", "alias": "Vikram Mifos"}],
}


def metadata_roster() -> R.Roster:
    roster = R.Roster(CONFIG)
    R.read_ops_hub(roster, CONFIG, ORG)
    roster.see(R.Seen("workspace_directory", "synthetic@example.test", "Workspace directory · own account",
                      "Aasha Rao", current=True))
    roster.settle()
    return roster


def test_metadata_names_resolve_to_one_record_per_person():
    roster = metadata_roster()
    assert set(roster.entries) == {"asha rao", "vikram shah"}
    assert len(roster.entries["asha rao"].seen) == 2
    assert roster.unresolved == 0
    assert R.is_name("Asha Rao") and not R.is_name("Creative team") and not R.is_name("123")
    assert all(not R.is_name(role) for role in (
        "Copywriter", "Shoot Coordinator", "Video Editor", "Graphic Designer", "Social Media"))
    assert R.norm("Datup L. Velupenubo") == "datup velupenubo"
    assert R.norm("Azavez Maam") == "azavez"


def test_decide_still_reads_existing_hr_document_rows():
    entry = R.Entry("Meera Iyer")
    entry.seen.append(R.Seen("hr_document", "synthetic-attendance", "Attendance sheet · synthetic",
                             "Meera Iyer", role="Video Editor", department="Creative",
                             last_seen=date(2026, 7, 1), restricted=True,
                             joined=date(2025, 8, 25), joined_note="Synthetic HR source"))

    fields, sources, flags = R.decide(entry, date(2026, 7, 1), set(), "Leadership")

    assert fields["status"] == "active"
    assert fields["role"] == "Video Editor" and fields["department"] == "Creative"
    assert fields["joined_on"] == date(2025, 8, 25)
    assert sources["joined_on"]["source"] == "Attendance sheet · synthetic"
    assert flags == []


def test_decide_flags_metadata_disagreements_and_stale_hr_only_people():
    roster = metadata_roster()
    asha = roster.entries["asha rao"]
    asha.seen.append(R.Seen("groups_roster", "pod2", "Planned groups roster · pod2@", "Asha Rao",
                            "Video Editor", "pod2", pod="Pod 2", current=True))
    fields, _, flags = R.decide(asha, None, set(), "Leadership")
    assert fields["role"] == "PGS" and fields["pod"] == "Pod 1" and fields["status"] == "active"
    assert [flag["field"] for flag in flags] == ["role", "pod"]

    historical = R.Entry("Kabir Sen")
    historical.seen.append(R.Seen("hr_document", "synthetic-old", "HR report · synthetic", "Kabir Sen",
                                  last_seen=date(2026, 5, 1), restricted=True))
    fields, _, flags = R.decide(historical, date(2026, 7, 1), set(), "Leadership")
    assert fields["status"] == "inactive" and [flag["field"] for flag in flags] == ["status"]
