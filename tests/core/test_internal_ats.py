"""R49 internal job matching in the database: required and preferred skill requirements, deterministic matched /
unknown / missing per requirement with published, editable weights; synonyms (the job's accepted alternatives, approved
exact and close mappings, a skill the source replaced), several skills for one requirement counted once, unknown never
a minus, profile updates; HR and admins only, nobody filtered out, a human pick only after HR accepts the weights, the
person's check of what Pulse read; nothing crosses a company; attendance, leave, pay, chats, activity, contact and
private profile fields cannot move a score. Synthetic tenants, people, codes and labels only."""
import datetime
import json
import os
import re
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_structured_skills import S, accepted_task, claim, concept, esco_csv, importing, local_skill, manifest, V1, V2
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)

ONET_EDIT, ONET_SHEET = "2.C.9.z", "2.A.9.y"


def months_ago(n):
    d = datetime.date.today().replace(day=1)
    y, m = divmod(d.year * 12 + d.month - 1 - n, 12)
    return f"{y:04d}-{m + 1:02d}"


def call(api, w, who, fn, *args):
    return one(api, w, who, f"select pulse.{fn}({','.join(['%s'] * len(args))}) r", args)["r"]


def world(api, worker, w, tmp_path):
    """ESCO v1 → O*NET with an exact and a close mapping → claims → ESCO v2 (drone replaced by pilot) → a job."""
    importing(worker, w, manifest(tmp_path, "v1.json", esco_csv(tmp_path / "skills_v1.csv", V1)))
    onet = tmp_path / "content_model.txt"
    onet.write_text(f"Element ID\tElement Name\tDescription\n{ONET_SHEET}\tSynthetic Spreadsheets\tSynthetic.\n{ONET_EDIT}\tSynthetic Film Editing\tSynthetic.\n")
    (tmp_path / "map.csv").write_text(f"fromFamily,fromCode,toFamily,toCode,relation\nesco,{S['sheet']},onet,{ONET_SHEET},exact\nesco,{S['edit']},onet,{ONET_EDIT},close\n")
    importing(worker, w, manifest(tmp_path, "onet.json", onet, family="onet", version="30.0-synthetic", dataLicence="Synthetic fixture licence",
                                  attribution="Synthetic O*NET attribution and modification notice",
                                  slice={"description": "Synthetic O*NET slice", "codes": [ONET_SHEET, ONET_EDIT]}, mappings="map.csv"))
    c = {k: concept(api, w, S[k])["id"] for k in ("edit", "sheet", "drone", "script")}
    c["onetEdit"], c["onetSheet"] = concept(api, w, ONET_EDIT)["id"], concept(api, w, ONET_SHEET)["id"]
    c["shoot"], c["reel"], c["scripts"] = local_skill(api, w), local_skill(api, w, "Reel editing"), local_skill(api, w, "Scriptwriting for reels")
    # Editor One: video editing verified at Strong with an accepted task, and two more skills the job takes for it.
    done = accepted_task(api, w, "Synthetic launch reel")
    c["editorEdit"] = claim(api, w, w.editor, w.editor, c["edit"], level=3, evidence=[{"kind": "task", "id": str(done)}])
    as_(api, w, w.editor2, "select pulse.skill_verify(%s,1,3,'Synthetic: saw the launch cut')", (c["editorEdit"],))
    claim(api, w, w.editor, w.editor, c["reel"], level=4)
    claim(api, w, w.editor, w.editor, c["onetEdit"], level=4)
    claim(api, w, w.editor, w.editor, c["shoot"], level=2)
    claim(api, w, w.editor, w.editor, c["onetSheet"], level=1)
    # Editor Two: a close mapping, and a drone skill the source later replaces.
    claim(api, w, w.editor2, w.editor2, c["onetEdit"], level=4)
    claim(api, w, w.editor2, w.editor2, c["drone"], level=3)
    # The outsider: video editing not used for two years, and a shoot level below the job's.
    claim(api, w, w.outsider, w.outsider, c["edit"], level=4, since="2023-01", lastUsed=months_ago(24))
    claim(api, w, w.outsider, w.outsider, c["shoot"], level=1)
    importing(worker, w, manifest(tmp_path, "v2.json", esco_csv(tmp_path / "skills_v2.csv", V2), version="2.0-synthetic",
                                  slice={"description": "Synthetic slice v2", "codes": [S[k] for k in ("edit", "sheet", "drone", "pilot")]}))
    c["pilot"] = concept(api, w, S["pilot"])["id"]
    job = call(api, w, w.lead, "ats_job_save", None, Jsonb({"title": "Synthetic launch editor", "purpose": "Synthetic: edits launch films"}))
    req = {}
    for key, concept_id, p in (("edit", c["edit"], {"importance": "required", "minLevel": 3, "recentMonths": 12, "also": [str(c["reel"])]}),
                               ("shoot", c["shoot"], {"importance": "required", "minLevel": 2}),
                               ("sheet", c["sheet"], {"importance": "preferred"}),
                               ("pilot", c["pilot"], {"importance": "preferred"}),
                               ("scripts", c["scripts"], {"importance": "preferred", "note": "Synthetic: nice to have"})):
        req[key] = call(api, w, w.lead, "ats_requirement_save", job, None, Jsonb({"conceptId": str(concept_id), **p}))
    return job, req, c


def by_person(cands):
    return {uuid.UUID(x["personId"]): x for x in cands["candidates"]}


def reqs(x):
    return {r["label"]: r for r in x["requirements"]}


def test_requirements_match_deterministically_with_published_weights(api, worker, team, tmp_path):  # noqa: F811
    w = team
    job, req, c = world(api, worker, w, tmp_path)
    # Requirements: one per skill, from the list, an offered skill, a level on the scale.
    for p, err in (({"conceptId": str(c["edit"]), "importance": "required"}, psycopg.errors.UniqueViolation),
                   ({"conceptId": str(c["script"]), "importance": "required"}, psycopg.errors.InvalidParameterValue),
                   ({"conceptId": str(uuid.uuid4()), "importance": "required"}, psycopg.errors.NoDataFound),
                   ({"conceptId": str(c["sheet"]), "importance": "essential"}, psycopg.errors.InvalidParameterValue),
                   ({"conceptId": str(c["drone"]), "importance": "preferred", "minLevel": 9}, psycopg.errors.InvalidParameterValue)):
        with pytest.raises(err):
            call(api, w, w.lead, "ats_requirement_save", job, None, Jsonb(p))
    cands = call(api, w, w.manager, "ats_candidates", job)
    assert cands["weights"]["version"] == 0 and cands["weights"]["default"] is True and cands["weights"]["accepted"] is None
    people = by_person(cands)
    # Nobody is left out: every active staff member is listed, including those with nothing on record.
    assert set(people) == {w.editor, w.editor2, w.lead, w.manager, w.outsider} and len(cands["candidates"]) == 5
    e = people[w.editor]
    r = reqs(e)
    # Several skills satisfy "edit video footage": the verified one counts once, the others are listed, not added.
    edit = r["edit video footage"]
    assert (edit["outcome"], edit["points"], edit["weight"]) == ("matched", 3, 3)
    assert {(x["label"], x["via"], x["basis"], x["counted"]) for x in edit["considered"]} == {
        ("edit video footage", "same", "verified", True), ("Reel editing", "alternative", "self", False), ("Synthetic Film Editing", "close", "self", False)}
    verified = next(x for x in edit["considered"] if x["counted"])
    assert verified["verified"]["by"] == "Editor Two" and verified["verified"]["basis"] == "manager" and verified["approvedWork"] == 1
    assert (r["Model shoot direction"]["outcome"], r["Model shoot direction"]["points"]) == ("matched", pytest.approx(1.8))
    sheet = r["use spreadsheet software"]
    assert (sheet["outcome"], sheet["points"], sheet["considered"][0]["via"]) == ("matched", pytest.approx(0.6), "exact")
    # Unknown is not inability: no record scores nothing, never a minus, and "up to" shows what checking could add.
    assert (r["pilot aerial camera"]["outcome"], r["Scriptwriting for reels"]["outcome"]) == ("unknown", "unknown")
    assert (float(e["points"]), float(e["max"]), float(e["upTo"])) == (pytest.approx(5.4), 9, pytest.approx(7.4))
    assert (e["matched"], e["unknown"], e["missing"], e["requiredUnknown"], e["requiredMissing"], e["rank"]) == (3, 2, 0, 0, 0, 1)
    # Editor Two: a close mapping counts 0.75 of a self-assessment; a skill the source replaced counts for its replacement.
    r2 = reqs(people[w.editor2])
    assert (r2["edit video footage"]["points"], r2["edit video footage"]["considered"][0]["via"]) == (pytest.approx(1.35), "close")
    assert (r2["pilot aerial camera"]["outcome"], r2["pilot aerial camera"]["considered"][0]["via"]) == ("matched", "replaced")
    assert r2["Model shoot direction"]["outcome"] == "unknown"
    # The outsider: not used within the 12 months asked counts half; a level below the job's is missing, not unknown.
    r3 = reqs(people[w.outsider])
    old = r3["edit video footage"]["considered"][0]
    assert (r3["edit video footage"]["points"], old["recent"], old["lastUsed"]) == (pytest.approx(0.9), False, months_ago(24))
    shoot = r3["Model shoot direction"]
    assert (shoot["outcome"], shoot["points"], shoot["considered"][0]["meetsLevel"]) == ("missing", 0, False)
    assert people[w.outsider]["requiredMissing"] == 1
    # Nothing on record: every requirement unknown, 0 points, up to the maximum; tied people share a rank.
    for p in (w.manager, w.lead):
        x = people[p]
        assert (float(x["points"]), float(x["upTo"]), x["unknown"], x["rank"]) == (0, 9, 5, 4)
    assert [uuid.UUID(x["personId"]) for x in cands["candidates"][:3]] == [w.editor, w.editor2, w.outsider]
    assert people[w.manager]["self"] is True and people[w.editor]["self"] is False
    # Deterministic: the same records give the same answer.
    unviewed = lambda xs: [{k: v for k, v in x.items() if k != "self"} for x in xs]  # noqa: E731  ("self" is the viewer)
    assert unviewed(call(api, w, w.lead, "ats_candidates", job)["candidates"]) == unviewed(cands["candidates"])

    # A profile update moves the score as the method says: a new level is self-assessed until verified again.
    claim(api, w, w.editor, w.editor, c["edit"], level=4)
    edit = reqs(by_person(call(api, w, w.lead, "ats_candidates", job))[w.editor])["edit video footage"]
    counted = next(x for x in edit["considered"] if x["counted"])
    assert (edit["points"], counted["basis"], counted["verifiedEarlier"], counted["level"]) == (pytest.approx(2.4), "approvedWork", True, 4)
    # Verified lower than the job asks: that skill no longer counts; the best other one that meets the level does.
    as_(api, w, w.editor2, "select pulse.skill_verify(%s,2,2,null)", (c["editorEdit"],))
    edit = reqs(by_person(call(api, w, w.lead, "ats_candidates", job))[w.editor])["edit video footage"]
    assert edit["points"] == pytest.approx(1.8) and [(x["label"], x["meetsLevel"]) for x in edit["considered"] if x["counted"]] == [("Reel editing", True)]
    assert next(x for x in edit["considered"] if x["label"] == "edit video footage")["level"] == 2

    # The weights are published and editable by HR and admins, as new versions with a reason.
    m = call(api, w, w.editor, "ats_method")
    assert m["current"]["weights"] == m["defaults"] and m["can"] == {"review": False, "accept": False}
    good = {"required": 4, "preferred": 1, "verified": 1, "approvedWork": 0.9, "self": 0.5, "close": 0.5, "notRecent": 0.25}
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        call(api, w, w.editor, "ats_weights_set", Jsonb(good), "Synthetic")
    for bad, msg in (({**good, "preferred": 5}, "preferred"), ({**good, "self": 0.95}, "Verified counts"), ({**good, "close": "high"}, "number"),
                     ({**good, "notRecent": 2}, "share"), ({**good, "required": 0.5, "preferred": 0}, "at least 1")):
        with pytest.raises(psycopg.errors.InvalidParameterValue, match=msg):
            call(api, w, w.lead, "ats_weights_set", Jsonb(bad), "Synthetic")
    assert call(api, w, w.manager, "ats_weights_set", Jsonb(good), "Synthetic: required skills matter more") == 1
    after = by_person(call(api, w, w.lead, "ats_candidates", job))
    assert after[w.editor]["max"] == 4 + 4 + 1 + 1 + 1 and reqs(after[w.editor])["edit video footage"]["points"] == pytest.approx(2.0)
    assert reqs(after[w.outsider])["edit video footage"]["points"] == pytest.approx(0.5)
    m = call(api, w, w.editor, "ats_method")
    assert m["current"]["version"] == 1 and m["current"]["setBy"] == "Pod Manager" and [v["version"] for v in m["versions"]] == [1]
    # A removed requirement leaves every score.
    as_(api, w, w.lead, "select pulse.ats_requirement_remove(%s)", (req["scripts"],))
    assert by_person(call(api, w, w.lead, "ats_candidates", job))[w.manager]["max"] == 10


def test_reviewers_pick_people_and_ask_them_to_check(api, worker, owner, team, tmp_path):  # noqa: F811
    w = team
    job, req, c = world(api, worker, w, tmp_path)
    # HR and admins only: not the person, their pod head or a colleague in another pod.
    for who in (w.editor, w.editor2, w.outsider):
        for fn, args in (("ats_jobs", ()), ("ats_job_read", (job,)), ("ats_candidates", (job,)),
                         ("ats_job_save", (None, Jsonb({"title": "Synthetic"}))),
                         ("ats_requirement_save", (job, None, Jsonb({"conceptId": str(c["drone"]), "importance": "preferred"}))),
                         ("ats_requirement_remove", (req["sheet"],)), ("ats_pick_add", (job, w.editor, "Synthetic")),
                         ("ats_check_ask", (job, w.outsider, req["shoot"], "Synthetic"))):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                call(api, w, who, fn, *args)
    assert [j["title"] for j in call(api, w, w.manager, "ats_jobs")] == ["Synthetic launch editor"]
    # No pick while the job is a draft, nor before HR accepts the weights in force; an admin alone cannot accept.
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Open the job"):
        call(api, w, w.lead, "ats_pick_add", job, w.editor, "Synthetic: strongest launch cuts")
    call(api, w, w.lead, "ats_job_save", job, Jsonb({"title": "Synthetic launch editor", "status": "open"}))
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="not accepted"):
        call(api, w, w.lead, "ats_pick_add", job, w.editor, "Synthetic: strongest launch cuts")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        call(api, w, w.manager, "ats_accept", 0, "Synthetic: read three explanations")
    with pytest.raises(psycopg.errors.SerializationFailure):
        call(api, w, w.lead, "ats_accept", 1, "Synthetic: read three explanations")
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        call(api, w, w.lead, "ats_accept", 0, "ok")
    call(api, w, w.lead, "ats_accept", 0, "Synthetic: read the explanations for Editor One, Editor Two and the outsider")
    assert call(api, w, w.editor, "ats_method")["current"]["accepted"]["by"] == "Project Lead"
    # A pick keeps the reason and the explanation as it stood; nobody picks themself; once only.
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="Someone else"):
        call(api, w, w.lead, "ats_pick_add", job, w.lead, "Synthetic")
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        call(api, w, w.lead, "ats_pick_add", job, w.editor, "")
    pick = call(api, w, w.lead, "ats_pick_add", job, w.editor, "Synthetic: strongest launch cuts")
    with pytest.raises(psycopg.errors.UniqueViolation):
        call(api, w, w.manager, "ats_pick_add", job, w.editor, "Synthetic: again")
    with owner.transaction():
        set_tenant(owner, w.org)
        kept = owner.execute("select match,weights_version from pulse.ats_pick where id=%s", (pick,)).fetchone()
    assert kept["weights_version"] == 0 and float(kept["match"]["points"]) == pytest.approx(5.4)
    j = call(api, w, w.manager, "ats_job_read", job)
    assert [(p["person"], p["note"], p["by"], p["withdrawn"]) for p in j["picks"]] == [("Editor One", "Synthetic: strongest launch cuts", "Project Lead", None)]
    assert by_person(call(api, w, w.lead, "ats_candidates", job))[w.editor]["picked"] is True
    as_(api, w, w.manager, "select pulse.ats_pick_withdraw(%s,'Synthetic: role changed')", (pick,))
    assert call(api, w, w.lead, "ats_job_read", job)["picks"][0]["withdrawn"]["by"] == "Pod Manager"
    # New weights need HR's acceptance again before anyone is picked.
    call(api, w, w.lead, "ats_weights_set", Jsonb({**call(api, w, w.lead, "ats_method")["defaults"], "required": 4}), "Synthetic")
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="not accepted"):
        call(api, w, w.lead, "ats_pick_add", job, w.editor2, "Synthetic")

    # The correction route: HR asks the outsider to check their shoot level; they see the question and what Pulse read
    # about them for that skill only: not the job, other requirements or anyone else.
    chk = call(api, w, w.lead, "ats_check_ask", job, w.outsider, req["shoot"], "Synthetic: is Learning still right for model shoots?")
    with pytest.raises(psycopg.errors.UniqueViolation):
        call(api, w, w.manager, "ats_check_ask", job, w.outsider, req["shoot"], "Synthetic: again")
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        call(api, w, w.lead, "ats_check_ask", job, w.lead, req["shoot"], "Synthetic: myself")
    mine = call(api, w, w.outsider, "ats_my_checks")
    assert len(mine) == 1 and mine[0]["skill"] == "Model shoot direction" and mine[0]["before"]["outcome"] == "missing"
    text = json.dumps(mine)
    assert "Synthetic launch editor" not in text and "edits launch films" not in text and "Editor One" not in text and "requirementId" not in text
    assert {x["label"] for x in mine[0]["before"]["considered"]} == {"Model shoot direction"}
    assert call(api, w, w.editor, "ats_my_checks") == [] and call(api, w, w.editor2, "ats_my_checks") == []
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.ats_check_answer(%s,'Synthetic')", (chk,))
    # The person corrects their own record (R48) and answers; the after-reading is kept beside the before.
    claim(api, w, w.outsider, w.outsider, c["shoot"], level=3)
    assert call(api, w, w.outsider, "ats_my_checks")[0]["now"]["outcome"] == "matched"
    as_(api, w, w.outsider, "select pulse.ats_check_answer(%s,'Synthetic: I ran the August shoots; updated')", (chk,))
    seen = call(api, w, w.lead, "ats_job_read", job)["checks"][0]
    assert (seen["before"], seen["after"], seen["answer"], seen["closed"]) == ("missing", "matched", "Synthetic: I ran the August shoots; updated", None)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.outsider, "select pulse.ats_check_close(%s,null)", (chk,))
    as_(api, w, w.lead, "select pulse.ats_check_close(%s,'Synthetic: thanks')", (chk,))
    assert call(api, w, w.outsider, "ats_my_checks")[0]["now"] is None
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="closed"):
        as_(api, w, w.outsider, "select pulse.ats_check_answer(%s,'Synthetic: late')", (chk,))

    # Another company: its admin finds no job, no candidate and no weights of this one; its list holds only its own people.
    other = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, other.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2026-01-01')", (other.org, other.manager))
    assert call(api, other, other.manager, "ats_jobs") == []
    for fn, args in (("ats_job_read", (job,)), ("ats_candidates", (job,)), ("ats_pick_add", (job, w.editor, "Synthetic")),
                     ("ats_requirement_save", (job, None, Jsonb({"conceptId": str(c["drone"]), "importance": "preferred"})))):
        with pytest.raises(psycopg.errors.NoDataFound):
            call(api, other, other.manager, fn, *args)
    assert call(api, other, other.manager, "ats_method")["current"]["version"] == 0
    theirs = call(api, other, other.manager, "ats_job_save", None, Jsonb({"title": "Synthetic other job"}))
    assert {uuid.UUID(x["personId"]) for x in call(api, other, other.manager, "ats_candidates", theirs)["candidates"]} == {other.editor, other.editor2, other.lead, other.manager}
    with pytest.raises(psycopg.errors.NoDataFound):
        call(api, other, other.manager, "ats_check_ask", theirs, w.editor, req["shoot"], "Synthetic")


PRIVATE_WORDS = ("they/them", "Synthetic town", "Synthetic role", "2001", "999999", "expert video editor", "intern")


def change_private_attributes(owner, w):
    """Change what matching (and the coach packet, R50) must never read: profile fields, contact, pay, attendance,
    leave, chats and app activity."""
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("""update pulse.people_profile set pronouns='they/them', languages=array['hi','mr'], about='Synthetic about', joined_on='2001-01-01',
                         work_location='Synthetic town', department='Synthetic dept', role='Synthetic role', employment_type='intern' where person_id in (%s,%s,%s)""",
                      (w.editor, w.editor2, w.outsider))
        set_tenant(owner, w.org, w.lead)  # HR writes contact details
        owner.execute("""insert into pulse_priv.hr_contact(org_id,person_id,personal_email,personal_phone,source) values(%s,%s,'synthetic@example.test','+910000000000','synthetic')
                         on conflict do nothing""", (w.org, w.outsider))
        for p, amount in ((w.editor, 1), (w.outsider, 999999)):
            owner.execute("""insert into pulse_priv.hr_compensation(org_id,person_id,effective_month,kind,amount,source_file_id,source_name,source_sheet,basis)
                             values(%s,%s,'2026-01-01','monthly',%s,'synthetic','synthetic','synthetic','synthetic')""", (w.org, p, amount))
            owner.execute("insert into pulse.attendance_entry(org_id,person_id,checked_in_at,work_date,mode,late_minutes) values(%s,%s,now()-interval '9 hours',current_date,'office',240)", (w.org, p))
            owner.execute("insert into pulse.leave_request(org_id,person_id,from_date,to_date,leave_kind,status) values(%s,%s,current_date,current_date+5,'sick','approved')", (w.org, p))
        ch = owner.execute("insert into pulse.chat_channel(org_id,key,name,kind) values(%s,'syn-r49','Synthetic','group') returning id", (w.org,)).fetchone()["id"]
        owner.execute("insert into pulse.chat_message(org_id,channel_id,author_id,body,client_id) values(%s,%s,%s,'Synthetic: I am an expert video editor',%s)",
                      (w.org, ch, w.outsider, str(uuid.uuid4())))
        owner.execute("""insert into pulse.activity_observation(org_id,source_key,at,operation,actor_id,actor_kind,human_attribution,confidence,basis)
                         values(%s,'syn:r49',now(),'edit',%s,'person','direct',1,'synthetic')""", (w.org, w.outsider))
        owner.execute("update pulse.person set tracking_excluded=true where id=%s", (w.editor2,))


FORBIDDEN = ("attendance", "presence", "leave", "payroll", "payslip", "salary", "compensation", "hr_", "chat", "activity", "attention",
             "work_credit", "help_rating", "kudos", "notification", "access_log", "people_profile", "people_info", "hr_contact", "device",
             "companion", "dwell", "delivery", "lifecycle", "pronoun", "joined", "birth", "gender", "language")
ALLOWED = {"ats_requirement", "skill_mapping", "skill_concept", "person_skill", "skill_verification", "person_skill_evidence", "via", "acc",
           "e", "task", "people_work_link", "person_experience", "person", "unnest", "jsonb_array_elements"}


def test_private_attributes_cannot_move_a_score(api, worker, owner, team, tmp_path):  # noqa: F811
    w = team
    job, _, _ = world(api, worker, w, tmp_path)
    before = call(api, w, w.lead, "ats_candidates", job)
    change_private_attributes(owner, w)
    after = call(api, w, w.lead, "ats_candidates", job)
    assert after == before
    # Random IDs and timestamp microseconds can contain private numbers; keep dates to catch joined_on.
    text = re.sub(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", "", json.dumps(after), flags=re.I)
    text = re.sub(r"(?<=\d{4}-\d{2}-\d{2})[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?", "", text)
    for word in PRIVATE_WORDS:
        assert word not in text
    # The evaluator reads only the job, the skill list, claims, verifications and linked work's approval.
    with api.transaction():
        src = {r["proname"]: r["prosrc"] for r in api.execute("""select p.proname, p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='pulse' and p.proname in ('ats_requirement_eval','ats_match_eval','skill_evidence_state','ats_person_name')""").fetchall()}
    assert len(src) == 4
    for name, body in src.items():
        low = body.lower()
        assert not [f for f in FORBIDDEN if f in low], name
        used = set(re.findall(r"\b(?:from|join)\s+(?:lateral\s+)?(?:pulse\.)?([a-z_]+)", low))
        assert used <= ALLOWED, (name, used - ALLOWED)


def test_http_jobs_candidates_picks_and_checks(worker, owner, api, team, tmp_path):  # noqa: F811
    """services/api/test/ats-runner.mjs: the same rules over HTTP with real password sessions."""
    w = team
    job, req, c = world(api, worker, w, tmp_path)
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        for pid in (w.manager, w.editor, w.editor2, w.lead, w.outsider):
            api.execute("select pulse.login_issue(%s,'Synthetic-issued-2026!')", (pid,))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    ids = {"job": str(job), "editor": str(w.editor), "outsider": str(w.outsider), "shootReq": str(req["shoot"]), "drone": str(c["drone"])}
    proc = subprocess.run(["node", "test/ats-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api",
                          env={**os.environ, "TEST_API_CONFIG": json.dumps(config), "PULSE_ORG_ID": str(w.org), "TEST_IDS": json.dumps(ids)},
                          capture_output=True, text=True, timeout=120, check=False)
    assert proc.returncode == 0, proc.stderr + proc.stdout


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_ats_pages_in_the_browser(worker, owner, api, team, tmp_path):  # noqa: F811
    """services/api/test/ats-browser-runner.mjs: accept the method, read explanations, pick, ask; the person answers.
    Screenshots with PULSE_R49_SCREENSHOTS."""
    w = team
    job, _, _ = world(api, worker, w, tmp_path)
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config), "PULSE_R49_REPORT": str(tmp_path / "r49.json"),
           "TEST_IDS": json.dumps({"job": str(job), "editor": str(w.editor), "editorEmail": w.editor_handle, "headEmail": f"editor2@{w.domain}"})}
    p = subprocess.run(["node", "test/ats-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=2400, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-6000:]
    assert json.loads((tmp_path / "r49.json").read_text())["browserChecks"] >= 40
