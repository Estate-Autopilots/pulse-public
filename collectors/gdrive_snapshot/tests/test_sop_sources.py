"""SOP-WORKFLOW: which Drive documents become SOP sources, with synthetic documents and made-up numbers only."""

from pulse_gdrive_snapshot import sop_sources as S

STEPS = "\n".join(f"{i}. Step number {i}\n   * Do the synthetic thing for step {i} carefully." for i in range(1, 8))
HR = {"hr@example.test"}


def row(name, body, **kw):
    return {
        "id": kw.get("id", "f-" + name),
        "name": name,
        "mime": kw.get("mime", S.DOC),
        "path": kw.get("path", "My Drive/" + name),
        "link": "https://docs.example/d/1",
        "owner": kw.get("owner", "ops@example.test"),
        "seen_by": kw.get("seen_by", ["ops@example.test"]),
        "modified": None,
        "body": body,
    }


def test_a_titled_sop_with_numbered_steps_scores_high_with_reasons():
    c = S.judge(
        row(
            "Shoot coordination SOP",
            "Process for the shoot\n" + STEPS + "\nThe coordinator and the client agree on the day.",
        ),
        HR,
    )
    assert c and c.score >= 0.6
    assert c.reasons[0] == "The title says “SOP”" and "7 numbered steps" in c.reasons


def test_rosters_pay_private_and_hr_only_documents_are_never_captured():
    roster = "\n".join(f"Model {i} | model{i}@example.test | 98765{i:05d}" for i in range(5))
    assert S.judge(row("Models SOP", "Models list\n" + roster + "\n" + STEPS), HR) is None, (
        "a roster is not a procedure"
    )
    assert S.judge(row("Model Pay Tracker SOP", STEPS), HR) is None
    assert S.judge(row("Process", STEPS, path="My Drive/Recovery Kit (private - do not share)/Process"), HR) is None
    assert S.judge(row("Onboarding SOP", STEPS, owner="hr@example.test", seen_by=["hr@example.test"]), HR) is None
    shared = S.judge(
        row("Onboarding SOP", STEPS, owner="hr@example.test", seen_by=["hr@example.test", "ops@example.test"]), HR
    )
    assert shared is not None, "shared beyond HR: an ordinary SOP"
    assert S.judge(row("Weekly notes", "We met. " * 80), HR) is None, "neither the title nor the text says it is an SOP"


def test_a_contact_table_inside_an_sop_is_cut_out_and_stray_numbers_redacted():
    body = (
        "Client Visit – Process\n"
        + STEPS
        + "\n\n\nCrew details\n\tName\n\tContact\n\t1.\n\tSynthetic Crew\n\t9876543210\n"
        + "\t2.\n\tOther Crew\n\t9123456789\n\t3.\n\tThird\n\t9988776655\n"
    )
    c = S.judge(row("Visit SOP", body + "\n\n\nWrite to help@example.test if stuck."), HR)
    assert c is not None
    assert "9876543210" not in c.body and "Synthetic Crew" not in c.body and "help@example.test" not in c.body
    assert "A list of people's contact details in it was left out" in c.reasons
    assert S.redact("call 98765 43210 or a@b.co, ID 2345 6789 0124") == "call [phone] or [e-mail], ID [number]"


def test_client_folders_books_and_copies_rank_lower():
    base = S.judge(row("Shoot process", STEPS), HR).score
    assert (
        S.judge(row("Shoot process", STEPS, path="Client Video Shoot/2026/#1 - Synthetic Heights/Shoot process"), HR)
        is None
        or S.judge(
            row("Shoot process", STEPS, path="Client Video Shoot/2026/#1 - Synthetic Heights/Shoot process"), HR
        ).score
        < base - 0.2
    )
    long_read = "A process of ongoing improvement. " * 2500
    book = S.judge(row("The Goal: A Process", long_read, path="books/The Goal"), HR)
    assert book is None or book.score < S.THRESHOLD
    assert S.judge(row("Copy of Shoot process", STEPS), HR).score < base
