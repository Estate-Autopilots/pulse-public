"""LIFECYCLE scanner: which mails are exit letters, whom they name, the last working day, and Workspace evidence.
Synthetic names and mailboxes only."""

import uuid
from datetime import UTC, date, datetime

from pulse_workers.lifecycle_scan import (
    Person,
    kind_of,
    last_day,
    mail_signals,
    match,
    names_in,
    roster_signals,
    workspace_signals,
)

HR = {"hr@company.example"}
P = {
    n: Person(uuid.uuid4(), n, "active")
    for n in ("Ravi Kalah", "Neha Jivop", "Anil Rao", "Omi Ubuk", "Sita", "Om Lazuno", "Mira Shah", "Mira Shah ")
}


def mail(subject, sender, snippet, on="2026-09-21T10:00:00+00:00"):
    return {"subject": subject, "from_addr": sender, "snippet": snippet, "sent_at": datetime.fromisoformat(on)}


def test_letters_are_read_from_their_subjects_and_replies_only_when_withdrawn():
    assert kind_of("Resignation Letter – Ravi Kalah", "Dear Ma&#39;am") == "resigned"
    assert kind_of("Notice of Resignation.", "") == "resigned"
    assert kind_of("Employment Termination Notice", "") == "terminated"
    assert kind_of("Employment Closure Documents - Anil Rao", "") == "closed"
    assert kind_of("Experience letter", "") == "closed"
    assert kind_of("Re: Notice of Resignation.", "Acknowledged. On Wed ...") is None
    assert (
        kind_of("Re: Resignation – Last Working Day: 31 August 2026", "Mam please note I've cancelled my resignation.")
        == "cancelled"
    )
    assert kind_of("Making the most of exit interviews", "") is None
    assert kind_of("Negotiating your exit from a company can…", "") is None


def test_last_working_day_in_the_ways_people_write_it():
    assert last_day("Formal Resignation – Neha Jivop | Last Working Day: 30 September 2026") == date(2026, 9, 30)
    assert last_day("with 31st May 2026 being my last working day. I appreciate") == date(2026, 5, 31)
    assert last_day("effective from 15th May 2026 to 31st May 2026. As discussed") == date(2026, 5, 31)
    assert last_day("relating to your last working day, 31 August 2026: 1. Employment") == date(2026, 8, 31)
    assert last_day("Please accept this email as my formal resignation") is None


def test_who_a_letter_is_about():
    assert names_in("resigned", "Resignation Letter – Ravi Kalah", "Ravi K <ravi.k@mail.example>", "", HR) == [
        "Ravi Kalah",
        "Ravi K",
    ]
    assert names_in(
        "resigned",
        "Formal Resignation – Neha Jivop | Last Working Day: 30 September 2026",
        "neha EA <shared@company.example>",
        "",
        HR,
    ) == ["Neha Jivop", "neha"]
    assert names_in(
        "terminated",
        "Employment Termination Notice",
        "HR Desk <hr@company.example>",
        "Dear Anil Rao, This is to formally",
        HR,
    ) == ["Anil Rao"]
    assert names_in(
        "closed", "Experience letter", "HR Desk <hr@company.example>", "Dear Om, Please find attached", HR
    ) == ["Om"]
    assert names_in(
        "resigned",
        "Resignation from the Position of Head of Operations",
        "MIRA SHAH <head@company.example>",
        "Dear Management,",
        HR,
    ) == ["Mira Shah"]


def test_matching_never_guesses_between_people():
    people = list(P.values())
    assert match("Ravi Kalah", people, {}) == [P["Ravi Kalah"].id]
    assert match("Ravee Kalah", people, {"Ravi Kalah": ["Ravee Kalah"]}) == [P["Ravi Kalah"].id]  # the roster's alias
    assert match("Sita Kharad", people, {}) == [P["Sita"].id]  # a record that holds only the first name
    assert match("Om", people, {}) == [P["Om Lazuno"].id]  # one person starts with it
    assert match("Omi Dendge", people, {}) == []  # same first name, another surname: someone else
    assert match("Neha", people, {}) == [P["Neha Jivop"].id]
    assert set(match("Mira Shah", people, {})) == {
        P["Mira Shah"].id,
        P["Mira Shah "].id,
    }  # duplicate records of one name


def test_mail_signals_name_people_or_keep_the_written_name():
    people = list(P.values())
    rows = [
        mail(
            "Resignation Letter – Ravi Kalah",
            "Ravi Kalah <ravi@mail.example>",
            "Dear Ma&#39;am, please accept",
            "2026-09-12T06:00:00+00:00",
        ),
        mail(
            "Re: Resignation Letter – Ravi Kalah",
            "HR Desk <hr@company.example>",
            "Acknowledged.",
            "2026-09-12T08:00:00+00:00",
        ),
        mail(
            "Resignation – Last Working Day: 31 August 2026",
            "Neha Jivop <neha@mail.example>",
            "Dear Mam, I am writing",
            "2026-08-02T06:00:00+00:00",
        ),
        mail(
            "Re: Resignation – Last Working Day: 31 August 2026",
            "Neha Jivop <neha@mail.example>",
            "Mam please note I&#39;ve cancelled my resignation.",
            "2026-08-25T06:00:00+00:00",
        ),
        mail(
            "Resignation Letter",
            "Omi Dendge <omi@mail.example>",
            "Dear Sir, I am writing to formally",
            "2024-11-22T06:00:00+00:00",
        ),
    ]
    out = {(s.kind, s.person_id, s.written_name) for s in mail_signals(rows, people, {}, HR)}
    assert ("resigned", P["Ravi Kalah"].id, None) in out
    assert ("resigned", P["Neha Jivop"].id, None) in out and ("cancelled", P["Neha Jivop"].id, None) in out
    assert ("resigned", None, "Omi Dendge") in out  # not in the team: listed apart, never matched to Omi Ubuk
    neha = next(
        s for s in mail_signals(rows, people, {}, HR) if s.kind == "resigned" and s.person_id == P["Neha Jivop"].id
    )
    assert (
        neha.last_day == date(2026, 8, 31) and neha.weight == 3 and "Resignation mail to HR, 2 Aug 2026" in neha.summary
    )
    assert all("Dear" not in s.summary for s in mail_signals(rows, people, {}, HR))  # never message text


def test_workspace_and_roster_evidence():
    pid, other = uuid.uuid4(), uuid.uuid4()
    users = [
        {
            "email": "gone@company.example",
            "suspended": True,
            "created": datetime(2025, 1, 1, tzinfo=UTC),
            "last_login": datetime(2026, 1, 1, tzinfo=UTC),
        },
        {
            "email": "quiet@company.example",
            "suspended": False,
            "created": datetime(2025, 1, 1, tzinfo=UTC),
            "last_login": datetime(2026, 7, 1, tzinfo=UTC),
        },
        {
            "email": "new@company.example",
            "suspended": False,
            "created": datetime(2026, 10, 1, tzinfo=UTC),
            "last_login": datetime(1970, 1, 1, tzinfo=UTC),
        },
        {
            "email": "shared@company.example",
            "suspended": True,
            "created": datetime(2025, 1, 1, tzinfo=UTC),
            "last_login": None,
        },
    ]
    holders = {"gone@company.example": [pid], "quiet@company.example": [other], "new@company.example": [uuid.uuid4()]}
    out = {(s.person_id, s.kind, s.weight) for s in workspace_signals(users, holders, date(2026, 10, 11))}
    assert out == {(pid, "suspended", 3), (other, "no_signin", 2)}  # new accounts and shared mailboxes say nothing
    people = list(P.values())
    listed = [p.name for p in people if p.name != "Anil Rao"] + ["Someone Else"] * 5
    assert [s.person_id for s in roster_signals(listed, date(2026, 10, 5), people, {})] == [P["Anil Rao"].id]
    assert roster_signals(listed[:3], date(2026, 10, 5), people, {}) == []  # too short to be a roster


def test_a_first_name_alone_never_reaches_someone_else():
    om = Person(uuid.uuid4(), "Omi Ubuk", "active", date(2025, 6, 25))
    people = [om, Person(uuid.uuid4(), "Ravi Kalah", "active")]
    rows = [
        mail(
            "Resignation Letter",
            "Omi Dendge <omi@mail.example>",
            "Dear Sir, I am writing to formally",
            "2024-11-22T06:00:00+00:00",
        ),
        mail(
            "Experience Letter",
            "Company <office@company.example>",
            "Dear Omi, We hope this email finds you well.",
            "2024-12-09T06:00:00+00:00",
        ),
    ]
    out = mail_signals(rows, people, {}, HR)
    assert all(s.person_id != om.id for s in out)  # another Omi resigned: "Dear Omi," is not Omi Ubuk
    assert {s.written_name for s in out} == {"Omi Dendge", "Omi"}
    # Even an exact name never reaches someone for a letter dated before they joined.
    early = mail(
        "Resignation Letter – Omi Ubuk", "Omi Ubuk <x@mail.example>", "Dear Ma'am", "2025-01-10T06:00:00+00:00"
    )
    assert all(s.person_id is None for s in mail_signals([early], people, {}, HR))
