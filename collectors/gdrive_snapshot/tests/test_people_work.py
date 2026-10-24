"""PEOPLE-LIVE importer rules, using synthetic names, projects and sheets only."""
# ruff: noqa: E501  (synthetic rows kept on one line)
import uuid
from datetime import date

from pulse_gdrive_snapshot import people_work as W

ORG = uuid.UUID("00000000-0000-0000-0000-0000000000bb")
CONFIG = {"name_aliases": {"Asha Rao": ["Aasha Rao", "Asha"]}, "confirm_same_person": [{"name": "Vikram Shah", "alias": "Vikram Mifos"}],
          "shared_local_parts": ["shoot"]}


def person(name, status="active", pod=None, email=None, role="Editor"):
    return {"id": uuid.uuid5(ORG, name), "display_name": name, "status": status, "pod": pod, "locked": [], "email": email, "role": role}


STAFF = [person("Asha Rao", pod="Pod 1"), person("Vikram Shah"), person("Meera"), person("Ravi Zorvan"), person("Ravi Putig", status="inactive"),
         person("Kedab Jivop", status="inactive")]
PROJECTS = [{"id": uuid.uuid5(ORG, n), "name": n, "title": t, "project_key": t.lower(), "start_month": s, "status": "active"} for n, t, s in (
    ("#25 - Lake View | Mr. Synthetic One | Townside | Aug 2025 | R", "Lake View", date(2025, 8, 1)),
    ("#2 - Hill Crest | Townside | Sept 2026 | P", "Hill Crest", date(2026, 9, 1)),
    ("#9 - Hill Crest | Riverside | Jan 2025 | R", "Hill Crest", date(2025, 1, 1)),
    ("#4 - Garden Court | Mr. Synthetic Two | Oak Road | May 2026 | R", "Garden Court", date(2026, 5, 1)))]


def test_only_a_unique_full_roster_name_or_configured_alias_is_exact():
    people = W.People(STAFF, CONFIG)
    assert people.match("Asha Rao").exact and people.match("Mrs. Asha Rao (PGS)").exact
    alias = people.match("Aasha Rao")
    assert alias.exact and alias.person["display_name"] == "Asha Rao" and "alias" in alias.how
    assert people.match("Vikram Mifos").exact            # confirm_same_person works both ways
    one_word = people.match("Asha")
    assert one_word.person["display_name"] == "Asha Rao" and not one_word.exact
    meera = people.match("meera")                         # the roster knows only one word: never automatic
    assert meera.person["display_name"] == "Meera" and not meera.exact and meera.confidence == .9
    assert people.match("Meera Kharad").confidence == .85 and not people.match("Meera Kharad").exact
    assert people.match("Ravi").person["display_name"] == "Ravi Zorvan"        # the only current Ravi
    assert people.match("Kedab").confidence == .7                              # only a former person has the name
    assert people.match("Ravi Zorvann").how == "same first name, surname spelled differently"
    assert people.match("Vikram Shaw") is None                                 # too far apart to guess
    assert people.match("Rumam") is None and people.match("") is None and people.match("Production Head") is None


def test_project_cells_match_full_folder_names_titles_and_dates():
    projects = W.Projects(PROJECTS)
    hit, exact, conf = projects.match("#25 - Lake View | Mr. Synthetic One | Townside | Aug 2025 | R")
    assert hit["title"] == "Lake View" and exact and conf == 1.0
    assert projects.match("Sunday, December 14 - Lake View")[0]["title"] == "Lake View"
    assert W.project_text("VOV-Mr. Synthetic Two | Oak Road") == "mr. synthetic two | oak road"
    assert W.project_text("Saturday - 29 August, Garden Court") == "garden court"
    assert W.project_text("May Flower Residency") == "may flower residency"
    # Two projects share a title: the row's date picks the one that had started, and it stays a suggestion.
    hill, exact, conf = projects.match("Hill Crest", day=date(2026, 9, 15))
    assert hill["start_month"] == date(2026, 9, 1) and not exact and conf == .75
    assert projects.match("Hill Crest") is None
    assert projects.match("Garden Courtt")[2] == .7
    assert projects.match("Nothing Like It") is None


def test_privacy_rules_refuse_pay_and_private_titles():
    assert W.work_title("VOV — Lake View https://drive.google.com/x") == "VOV — Lake View"
    for private in ("Salary for March", "Per task payout ₹500", "Paid 2000 to editor", "Offer letter draft", "Aadhaar copy"):
        assert W.work_title(private) is None
    assert W.PRIVATE.search("Model & Cinematographer Pay Tracker") and W.PRIVATE.search("EA - PM Commission")
    assert W.PRIVATE.search("Apply for Video Editor (Responses)") and not W.PRIVATE.search("EA POD #1 | Image Creatives (Meera)")
    for hr_file in ("Asha_Growth_Strategist_TNA_Report_1.docx", "MASTER EMPLOYMENT AGREEMENT", "Warning letter - Meera", "Relieving letter"):
        assert W.PRIVATE.search(hr_file)
    assert not W.PRIVATE.search("Residential-Product-Training (2).pptx") and not W.PRIVATE.search("Feedback | Lake View | Mr. Synthetic One")


def test_months_media_and_statuses():
    assert W.month_of("VOV Mar 2026", 2020) == date(2026, 3, 1) and W.month_of("sept 26", 2020) == date(2026, 9, 1)
    assert W.month_of("Ridihu (March)", 2025) == date(2025, 3, 1) and W.month_of("Sheet1", 2025) is None
    assert W.media_of("Single Image C — Lake View", "creative editor") == "image"
    assert W.media_of("VOV — Lake View", "VOV Apr 2026", "creative editor") == "video"      # the title decides before the role
    assert W.media_of("Onboarding — Lake View") is None
    assert W.task_status("Closed") == "done" and W.task_status("In Review") == "in_review" and W.task_status("Edit Completed ") == "done"
    assert W.task_status("") == "unknown"


class Result:
    def __init__(self, rows=(), rowcount=1):
        self.rows, self.rowcount = list(rows), rowcount

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.rows[0] if self.rows else None


class Fake:
    """A connection that answers by table name and records inserts (no database)."""

    def __init__(self, answers):
        self.answers, self.inserts = answers, []

    def execute(self, sql, args=None):
        if sql.lstrip().lower().startswith("insert"):
            self.inserts.append((sql, args))
            return Result()
        for marker, rows in self.answers.items():
            if marker in sql:
                return Result(rows)
        return Result()


def importer(**kw):
    pulse = Fake({"from pulse.person p": STAFF, "from pulse.project": PROJECTS, "from pulse.unit": [{"name": "Pod 1"}, {"name": "Pod 2"}, {"name": "Shared"}]})
    return W.Importer(Fake({}), pulse, ORG, config=CONFIG, today=date(2026, 10, 10), **kw), pulse


def test_a_tracker_tab_becomes_task_rows_and_pm_links_without_pay_columns():
    imp, pulse = importer()
    imp.signatures = set()
    rows = [("Date", "Project Name", "Project File", "Video Type", "Assigned PM", "Editing Status", "Per Task"),
            (date(2026, 10, 1), "Lake View | Mr. Synthetic One", "#25 - Lake View | Mr. Synthetic One | Townside | Aug 2025 | R", "Model Video", "Asha", "Closed", 900),
            (date(2026, 10, 2), "Garden Court", None, "VOV", "Rumam", "In Review", 400),
            (None, None, None, None, None, None, None)]
    titled = imp._title_person("Meera Pod 2 Video Edit (Model n VOV)")
    assert titled.person["display_name"] == "Meera"
    assert imp._tracker_tab({"id": "sheet-1", "name": "Meera Pod 2 Video Edit (Model n VOV)"}, titled, "October 26", rows, 0) == 2
    tasks = [args for sql, args in pulse.inserts if "pulse.task" in sql]
    assert [t[2] for t in tasks] == ["Model Video — Lake View", "VOV — Garden Court"]
    assert tasks[0][4] == "done" and tasks[1][4] == "in_review" and tasks[0][7] == "video editor"
    # No assignee column: the person is the title's "Meera", as written, never an exact roster name; the evidence says so.
    assert tasks[0][6] == "Meera" and '"personFrom": "sheet title"' in str(tasks[0][-1].obj).replace("'", '"')
    assert all(900 not in t and 400 not in t and "per task" not in repr(t).lower() for t in tasks)   # the pay column never travels
    pm = [link for link in imp.links.values() if link.source == "tracker_pm"]
    assert len(pm) == 1 and pm[0].person["display_name"] == "Asha Rao" and pm[0].role == "Assigned PM" and not pm[0].auto
    # The same rows again (a copied tracker) are skipped by content; rows already imported are skipped by number.
    assert imp._tracker_tab({"id": "sheet-2", "name": "Copy of Meera Pod 2 Video Edit"}, titled, "October 26", rows, 0) == 0
    assert imp._tracker_tab({"id": "sheet-1", "name": "Meera Pod 2 Video Edit"}, titled, "October 26", rows, 3) == 0


def test_group_roster_pods_shared_for_cross_pod_groups_and_locks_respected(tmp_path):
    roster = tmp_path / "groups.csv"
    roster.write_text("group,role,name,email\npod2@x,member,Vikram Shah (PGS),\ncreative@x,member,Ravi Zorvan (Video Editor),\n"
                      "pod1@x,member,Asha Rao,\ncreative@x,member,Meera,\nteam@x,member,Kedab Jivop,\npod2@x,member,Unknown Person,\n")
    imp, _ = importer(groups_path=str(roster))
    imp.people.by_id[uuid.uuid5(ORG, "Vikram Shah")]["locked"] = ["pod"]
    imp.people.by_id[uuid.uuid5(ORG, "Vikram Shah")]["pod"] = "Pod 1"
    imp.groups()
    pods = {link.person["display_name"]: link for link in imp.links.values() if link.kind == "pod"}
    assert pods["Ravi Zorvan"].pod == "Shared" and pods["Ravi Zorvan"].auto                     # creative@ only: works for every pod
    assert pods["Vikram Shah"].pod == "Pod 2" and not pods["Vikram Shah"].auto and pods["Vikram Shah"].group_key == "pod:groups_vs_record"
    assert pods["Meera"].pod == "Shared" and not pods["Meera"].auto                            # one-word name: a suggestion
    assert "Asha Rao" not in pods and "Kedab Jivop" not in pods                                # already right; team@ names no pod
    assert imp.counts["group_members_unmatched"] == 1 and imp.sources["workspace_groups"]["pods_already_right"] == 1


def test_pgs_client_tabs_and_shoot_schedule_candidates(tmp_path):
    roster = tmp_path / "groups.csv"
    roster.write_text("group,role,name,email\nproduction@x,member,Ravi Zorvan (Videographer),\nproduction@x,member,Vikram Shah (Videographer),\nproduction@x,member,Shoot Coordinator,shoot@x\n")
    sheets = {"active": [("Asha ", [("Client Name ", "Location", "Result"), ("Lake View | Mr. Synthetic One", "Townside", "Good leads"), ("Unknown Client", "Nowhere", "")]),
                         ("Notes", [("Client Name", "Location"), ("Garden Court", "Oak Road")])],
              "shoot": [("Oct Shoot", [("Client", "Segments", "Deliverables", "Status", "Model"), ("Garden Court", "Mid", "Model video", "Done", "Synthetic model")])]}
    index = Fake({"from drive_file": [{"id": "active", "name": "Pod 1 Active Client & Result", "owner": "pm@x", "seen_by": [], "modified": None},
                                      {"id": "shoot", "name": "shoot Details", "owner": "shoot@x", "seen_by": [], "modified": None}]})
    imp, _ = importer(groups_path=str(roster), sheets=lambda meta: sheets[meta["id"]])
    imp.index = index
    imp.groups()
    imp.client_sheets()
    pgs = [lk for lk in imp.links.values() if lk.source == "active_clients"]
    assert [(lk.person["display_name"], lk.title, lk.role, lk.evidence["projectPod"]) for lk in pgs] == [("Asha Rao", "Lake View", "PGS for the client", "Pod 1")]
    assert pgs[0].confidence == .85 and not pgs[0].auto                                           # the tab names a first name only
    shoots = sorted((lk.person["display_name"], lk.title, lk.confidence) for lk in imp.links.values() if lk.source == "shoot_schedule")
    assert shoots == [("Ravi Zorvan", "Garden Court", .4), ("Vikram Shah", "Garden Court", .4)]  # who filmed is not recorded
    assert {"active_clients", "shoot_schedule"} <= imp.ok


def test_script_trackers_and_a_sheet_titled_by_its_person():
    imp, pulse = importer()
    imp.signatures = set()
    rows = [("Priority ", "Project PM ", "Script Assigned", "Client Name", "Project Details", "Status"),
            ("High", "Asha", "Meera", "Lake View | Mr. Synthetic One", "#25 - Lake View | Mr. Synthetic One | Townside | Aug 2025 | R", "Finalized ")]
    assert imp._tracker_tab({"id": "s1", "name": "Scripting Team Management "}, None, "March 2026", rows, 0) == 1
    task = next(args for sql, args in pulse.inserts if "pulse.task" in sql)
    assert task[2] == "Script — Lake View" and task[4] == "done" and task[6] == "Meera" and task[7] == "script writer"
    titled = imp._title_person("Meera Sheet ")
    assert titled.person["display_name"] == "Meera"
    sheet = [("Client Name", "Month", "Images ", "Brochures"), ("Garden Court", "Dec ", "Done", "-")]
    assert imp._tracker_tab({"id": "s2", "name": "Meera Sheet "}, titled, "Sheet1", sheet, 0) == 1
    assert W.TRACKER_NAME.search("VOV Scripts Tracker") and W.TRACKER_NAME.search("Scripting Team Management")
    assert imp._tracker_tab({"id": "s3", "name": "VOV Scripts Tracker "}, None, "Feb 2026", [rows[0], ("", "Asha", "Meera", "Garden Court", "", "Completed")], 0) == 1
    assert [args for sql, args in pulse.inserts if "pulse.task" in sql][-1][7] == "script writer"     # a script tracker, not video editing


def test_hr_mailboxes_drives_are_never_work_documents():
    imp, _ = importer()
    imp.config = {**CONFIG, "sensitive_access": ["hr@x.test"]}
    imp.accounts = {"hr@x.test": (STAFF[1], 1.0, "record e-mail"), "user-a0d47682@estateautopilots.com": (STAFF[0], 1.0, "record e-mail")}
    seen = []
    imp.index = type("I", (), {"execute": lambda self, sql, args=(): (seen.append(args), Result())[1]})()
    imp.documents()
    # hr@ is not even queried
    assert seen and seen[-1][1] == ["user-a0d47682@estateautopilots.com"]
