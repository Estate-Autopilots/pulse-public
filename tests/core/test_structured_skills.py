"""R48 structured skills in the database: a taxonomy only from an approved download with its version, hash, data and
software licences and attribution; stable ids across versions with renamed, former, hidden, deprecated and absent
terms; local skills and names marked local; claims only by the person, linked to work that is theirs (approved or
only claimed); a separate verification by a manager, pod head or HR on one version of a claim; experience confirmed
the same way; a person-reviewed CV that others read only as reviewed, logged; nothing crosses a company; no worker,
ingest or privacy path writes a claim. Synthetic tenants, people, codes and labels only (no real ESCO/O*NET data)."""
import csv
import hashlib
import json
import os
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
from pulse_workers import skill_taxonomy
from test_tasks_rt1 import as_, new_task, one, team  # noqa: F401  (team is a fixture)

ESCO_ATTRIBUTION = "This service uses the ESCO classification of the European Commission."
S = {n: f"urn:synthetic:esco:skill:{n}" for n in ("edit", "sheet", "drone", "script", "outside", "pilot")}
ESCO_COLS = ["conceptType", "conceptUri", "skillType", "reuseLevel", "preferredLabel", "altLabels", "hiddenLabels", "status",
             "modifiedDate", "scopeNote", "definition", "inScheme", "description", "isReplacedBy"]


def esco_csv(path: Path, rows):
    with path.open("w", newline="", encoding="utf-8") as f:
        out = csv.DictWriter(f, ESCO_COLS)
        out.writeheader()
        for code, label, alt, hidden, kind, status, replaced in rows:
            out.writerow({"conceptType": "KnowledgeSkillCompetence", "conceptUri": code, "skillType": kind, "reuseLevel": "cross-sector",
                          "preferredLabel": label, "altLabels": "\n".join(alt), "hiddenLabels": "\n".join(hidden), "status": status,
                          "description": f"Synthetic description of {label}.", "isReplacedBy": replaced or ""})
    return path


def manifest(tmp: Path, name: str, file: Path, **over):
    m = {"family": "esco", "version": "1.0-synthetic", "language": "en", "file": file.name,
         "fileSha256": hashlib.sha256(file.read_bytes()).hexdigest(),
         "dataLicence": "Synthetic fixture: stands in for the licence the approved download states",
         "softwareLicence": None, "attribution": ESCO_ATTRIBUTION, "sourceUrl": "https://example.test/esco-download",
         "slice": {"description": "Synthetic creative-team slice", "codes": [S[k] for k in ("edit", "sheet", "drone", "script")]},
         "approvalRef": "E16 synthetic approval record"}
    m.update(over)
    p = tmp / name
    p.write_text(json.dumps(m))
    return p


V1 = [(S["edit"], "edit video footage", ["video editing", "cut footage"], ["vidoe editing"], "skill/competence", "released", None),
      (S["sheet"], "use spreadsheets software", ["use spreadsheet programs"], [], "skill/competence", "released", None),
      (S["drone"], "operate camera drone", [], [], "skill/competence", "released", None),
      (S["script"], "scriptwriting principles", ["script writing"], [], "knowledge", "released", None),
      (S["outside"], "outside the approved slice", [], [], "skill/competence", "released", None)]
V2 = [(S["edit"], "edit video footage", ["video editing", "cut footage"], ["vidoe editing"], "skill/competence", "released", None),
      (S["sheet"], "use spreadsheet software", ["use spreadsheet programs"], [], "skill/competence", "released", None),
      (S["drone"], "operate camera drone", [], [], "skill/competence", "obsolete", S["pilot"]),
      (S["pilot"], "pilot aerial camera", ["fly camera drone"], [], "skill/competence", "released", None)]


def importing(worker, w, path):
    with worker.transaction():
        set_tenant(worker, w.org)
        return skill_taxonomy.load(worker, path)


def concept(api, w, code):
    return one(api, w, w.editor, "select id,label,status,replaced_by,family from pulse.skill_concept where code=%s", (code,))


def catalog(api, w, who, q):
    return one(api, w, who, "select pulse.skill_catalog(%s) c", (q,))["c"]


def esco_v1(worker, w, tmp_path):
    f = esco_csv(tmp_path / "skills_v1.csv", V1)
    return importing(worker, w, manifest(tmp_path, "v1.json", f))


def local_skill(api, w, label="Model shoot direction"):
    return one(api, w, w.lead, "select pulse.skill_local_add(%s,'Synthetic local skill') id", (label,))["id"]


def claim(api, w, who, person, cid, **p):
    return one(api, w, who, "select pulse.skill_claim_save(%s,%s,%s) id", (person, cid, Jsonb({"level": 2, **p})))["id"]


def profile(api, w, who, person):
    return one(api, w, who, "select pulse.skill_profile(%s) p", (person,))["p"]


def accepted_task(api, w, title):
    t = new_task(api, w, w.editor, title=title)
    as_(api, w, w.editor, "select pulse.task_move(%s,'in_progress')", (t,))
    as_(api, w, w.editor, "select pulse.task_move(%s,'done')", (t,))
    as_(api, w, w.editor2, "select pulse.task_accept(%s,3,4,null)", (t,))
    return t


def test_taxonomy_import_versions_ids_aliases_and_deprecated_terms(api, worker, team, tmp_path):  # noqa: F811
    w = team
    f1 = esco_csv(tmp_path / "skills_v1.csv", V1)
    # Refused before anything is written: another file, Lightcast, no slice, a collection with no codes.
    bad = manifest(tmp_path, "bad.json", f1, fileSha256="0" * 64)
    with pytest.raises(skill_taxonomy.Refused, match="not the approved file"):
        skill_taxonomy.read(bad)
    with pytest.raises(skill_taxonomy.Refused, match="commercial contract"):
        skill_taxonomy.read(manifest(tmp_path, "lc.json", f1, family="lightcast"))
    with pytest.raises(skill_taxonomy.Refused, match="narrow slice"):
        skill_taxonomy.read(manifest(tmp_path, "all.json", f1, slice={"description": "everything"}))
    # The database refuses a missing approval, the API software licence given as the data licence, and an ESCO
    # attribution without ESCO's sentence.
    for over, msg in (({"approvalRef": ""}, "approval"), ({"dataLicence": "EUPL 1.2"}, "EUPL covers"),
                      ({"attribution": "Skills from Europe"}, "attribution must include")):
        with pytest.raises(psycopg.errors.InvalidParameterValue, match=msg):
            importing(worker, w, manifest(tmp_path, "x.json", f1, **over))
    # Version 1: the approved slice only (four of five), with its provenance.
    r1 = importing(worker, w, manifest(tmp_path, "v1.json", f1))
    assert (r1["added"], r1["concepts"], r1["deprecated"], r1["absent"], r1["inFile"], r1["inSlice"]) == (4, 4, 0, 0, 5, 4)
    assert concept(api, w, S["outside"]) is None
    src = as_(api, w, w.editor, "select * from pulse.skill_source")
    assert len(src) == 1 and src[0]["data_licence"].startswith("Synthetic fixture") and src[0]["software_licence"] is None
    assert ESCO_ATTRIBUTION in src[0]["attribution"] and "4 concepts" in src[0]["adapted"] and src[0]["approval_ref"]
    assert src[0]["file_sha256"] == hashlib.sha256(f1.read_bytes()).hexdigest() and "4 of 5" in src[0]["slice"]
    # The picker: alternative names are shown as matched, hidden ones match but never show; attribution travels along.
    c = catalog(api, w, w.editor, "video edit")
    assert [i["code"] for i in c["items"]] == [S["edit"]] and c["items"][0]["matched"]["label"] == "video editing"
    hidden = catalog(api, w, w.editor, "vidoe")
    assert hidden["items"][0]["code"] == S["edit"] and hidden["items"][0]["matched"] is None
    assert [s["attribution"] for s in c["sources"]] == [ESCO_ATTRIBUTION] and c["sources"][0]["softwareLicence"] is None
    # A local name (here Hindi) is marked local; only HR and admins add one.
    edit = concept(api, w, S["edit"])
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.skill_alias_add(%s,'वीडियो एडिटिंग','hi')", (edit["id"],))
    as_(api, w, w.lead, "select pulse.skill_alias_add(%s,'वीडियो एडिटिंग','hi')", (edit["id"],))
    hit = catalog(api, w, w.editor, "वीडियो")["items"][0]
    assert hit["id"] == str(edit["id"]) and hit["matched"] == {"label": "वीडियो एडिटिंग", "kind": "local", "language": "hi", "local": True, "former": False}
    # A claim on a term that is renamed in version 2 keeps its id.
    sheet = concept(api, w, S["sheet"])
    drone = concept(api, w, S["drone"])
    mine = claim(api, w, w.editor, w.editor, sheet["id"], level=2)
    claim(api, w, w.editor, w.editor, drone["id"], level=3)
    # Version 2: renamed, deprecated with a replacement, absent from the new slice, one new.
    f2 = esco_csv(tmp_path / "skills_v2.csv", V2)
    m2 = manifest(tmp_path, "v2.json", f2, version="2.0-synthetic",
                  slice={"description": "Synthetic creative-team slice, v2", "codes": [S[k] for k in ("edit", "sheet", "drone", "pilot")]})
    r2 = importing(worker, w, m2)
    assert (r2["added"], r2["updated"], r2["deprecated"], r2["absent"]) == (1, 3, 1, 1)
    with pytest.raises(psycopg.errors.UniqueViolation):
        importing(worker, w, m2)
    sheet2 = concept(api, w, S["sheet"])
    assert sheet2["id"] == sheet["id"] and sheet2["label"] == "use spreadsheet software"
    assert {s["version"]: s["superseded_at"] is None for s in as_(api, w, w.editor, "select version,superseded_at from pulse.skill_source")} == \
        {"1.0-synthetic": False, "2.0-synthetic": True}
    p = profile(api, w, w.editor, w.editor)
    by_code = {s["code"]: s for s in p["skills"]}
    assert by_code[S["sheet"]]["id"] == str(mine) and by_code[S["sheet"]]["label"] == "use spreadsheet software"
    assert by_code[S["drone"]]["status"] == "deprecated" and by_code[S["drone"]]["replacedBy"]["label"] == "pilot aerial camera"
    assert [s["version"] for s in p["sources"]] == ["2.0-synthetic"]
    # The old name still finds the concept, marked as a former name; deprecated and absent concepts come last.
    old = catalog(api, w, w.editor, "use spreadsheets software")["items"][0]
    assert old["id"] == str(sheet["id"]) and old["matched"]["former"] is True
    drones = catalog(api, w, w.editor, "camera")["items"]
    assert [i["code"] for i in drones] == [S["pilot"], S["drone"]] and drones[1]["status"] == "deprecated"
    assert concept(api, w, S["script"])["status"] == "absent"
    # Nobody adds a new claim on a concept the source deprecated; the existing claim stays.
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="pilot aerial camera"):
        claim(api, w, w.editor2, w.editor2, drone["id"])
    # O*NET with a mapping to ESCO: its own licence and attribution; an unknown end is counted, not guessed.
    onet = tmp_path / "content_model.txt"
    onet.write_text("Element ID\tElement Name\tDescription\n2.A.9.z\tSynthetic Active Viewing\tSynthetic.\n2.C.9.z\tSynthetic Film Knowledge\tSynthetic.\n")
    (tmp_path / "map.csv").write_text(f"fromFamily,fromCode,toFamily,toCode,relation\nesco,{S['edit']},onet,2.C.9.z,close\nesco,urn:synthetic:none,onet,2.A.9.z,close\n")
    r3 = importing(worker, w, manifest(tmp_path, "onet.json", onet, family="onet", version="30.0-synthetic",
                                        dataLicence="Synthetic fixture: CC BY 4.0 as the O*NET download states",
                                        attribution="Synthetic O*NET attribution and modification notice",
                                        slice={"description": "Synthetic O*NET slice", "codes": ["2.A.9.z", "2.C.9.z"]}, mappings="map.csv"))
    assert (r3["added"], r3["mapped"], r3["unresolvedMappings"]) == (2, 1, 1)
    kinds = {r["code"]: r["kind"] for r in as_(api, w, w.editor, "select code,kind from pulse.skill_concept where family='onet'")}
    assert kinds == {"2.A.9.z": "skill", "2.C.9.z": "knowledge"}
    # Another company sees none of it.
    with api.transaction():
        set_tenant(api, uuid.uuid4())
        assert api.execute("select count(*) n from pulse.skill_concept").fetchone()["n"] == 0
        assert api.execute("select count(*) n from pulse.skill_term").fetchone()["n"] == 0


def test_claims_are_the_persons_own_linked_to_their_work_and_never_inferred(api, worker, ingest, privacy, team):  # noqa: F811
    w = team
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.skill_local_add('Reel hooks')")
    shoot = local_skill(api, w)
    assert one(api, w, w.manager, "select pulse.skill_local_add('Reel hooks') id")["id"]
    with pytest.raises(psycopg.errors.UniqueViolation, match="already in the list"):
        local_skill(api, w, "model  SHOOT direction")
    item = catalog(api, w, w.editor, "shoot dir")["items"][0]
    assert item["family"] == "local" and item["local"] is True and item["code"] == f"local:{shoot}"
    # Work: an accepted task, one still in progress, a colleague's task, an RE project the editor is suggested on.
    done = accepted_task(api, w, "Synthetic launch reel")
    doing = new_task(api, w, w.editor, title="Synthetic teaser cut")
    theirs = new_task(api, w, w.editor2, title="Synthetic colleague task")
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("""insert into pulse.people_work_link(org_id,source_key,person_id,kind,project_id,title,source,confidence,basis,group_key,group_label)
                          values(%s,'syn:proj',%s,'project',%s,'Pilot project','synthetic',0.6,'Synthetic roster row','g','Synthetic')""",
                       (w.org, w.editor, w.project))
    ev = [{"kind": "task", "id": str(done)}, {"kind": "task", "id": str(doing)}, {"kind": "project", "id": str(w.project)}]
    sid = claim(api, w, w.editor, w.editor, shoot, level=3, since="2025-04", note="Synthetic note", evidence=ev)
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="only work you did"):
        claim(api, w, w.editor, w.editor, shoot, level=3, evidence=[{"kind": "task", "id": str(theirs)}])
    s = profile(api, w, w.editor, w.editor)["skills"][0]
    assert (s["id"], s["level"], s["since"], s["lastUsed"], s["verification"]) == (str(sid), 3, "2025-04", None, None)
    assert {e["title"]: e["state"] for e in s["evidence"]} == {"Synthetic launch reel": "approved", "Synthetic teaser cut": "claimed", "Pilot project": "claimed"}
    # Only the person writes their claim: not a colleague, their pod head, HR or an admin.
    for who in (w.editor2, w.lead, w.manager):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            claim(api, w, who, w.editor, shoot)
    for p, err in (({"level": 7}, "scale"), ({"since": "2099-01"}, "future"), ({"since": "April 2025"}, "month like"),
                   ({"since": "2025-06", "lastUsed": "2025-01"}, "comes before")):
        with pytest.raises(psycopg.errors.InvalidParameterValue, match=err):
            claim(api, w, w.editor, w.editor, shoot, **p)
    # No other path: the worker, ingest and privacy roles cannot write or call a claim, and the table accepts only 'self'.
    for conn in (worker, ingest, privacy):
        with pytest.raises(psycopg.errors.InsufficientPrivilege), conn.transaction():
            set_tenant(conn, w.org)
            conn.execute("insert into pulse.person_skill(org_id,person_id,concept_id,level) values(%s,%s,%s,2)", (w.org, w.editor2, shoot))
        with pytest.raises(psycopg.errors.InsufficientPrivilege), conn.transaction():
            set_tenant(conn, w.org, w.editor2)
            conn.execute("select pulse.skill_claim_save(%s,%s,'{\"level\":2}')", (w.editor2, shoot))
    with api.transaction():
        writers = api.execute("""select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname in ('pulse','pulse_priv','privacy') and p.prosrc ~* 'insert\\s+into\\s+(pulse\\.)?person_skill\\s*\\('""").fetchall()
        sources = api.execute("select pg_get_constraintdef(oid) d from pg_constraint where conrelid='pulse.person_skill'::regclass and contype='c'").fetchall()
    assert [r["proname"] for r in writers] == ["skill_claim_save"]
    assert any("'self'" in r["d"] and "source" in r["d"] for r in sources)
    # Removing a skill keeps the row (and its history) out of every read.
    as_(api, w, w.editor, "select pulse.skill_claim_remove(%s)", (sid,))
    assert profile(api, w, w.editor, w.editor)["skills"] == []
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor2, "select pulse.skill_claim_remove(%s)", (sid,))


def test_verification_is_separate_versioned_and_never_self(api, worker, owner, team):  # noqa: F811
    w = team
    shoot = local_skill(api, w)
    sid = claim(api, w, w.editor, w.editor, shoot, level=3)
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="never the person"):
        as_(api, w, w.editor, "select pulse.skill_verify(%s,1,3,null)", (sid,))
    # Only the person, their manager or pod head, HR and admins read the profile; an admin who is neither reads, never verifies.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        profile(api, w, w.outsider, w.editor)
    assert profile(api, w, w.manager, w.editor)["can"] == {"edit": False, "verify": False, "curate": True}
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.manager, "select pulse.skill_verify(%s,1,3,null)", (sid,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.outsider, "select pulse.skill_verify(%s,1,3,null)", (sid,))
    # The pod head marks what they saw: a lower level than the claim, which itself does not change.
    as_(api, w, w.editor2, "select pulse.skill_verify(%s,1,2,'Synthetic: saw two shoots')", (sid,))
    s = profile(api, w, w.editor2, w.editor)["skills"][0]
    assert (s["level"], s["verification"]["level"], s["verification"]["basis"], s["verification"]["current"]) == (3, 2, "manager", True)
    # The person changes the claim: the mark stays on version 1 ("verified earlier"); a stale decision is refused.
    claim(api, w, w.editor, w.editor, shoot, level=4)
    s = profile(api, w, w.editor, w.editor)["skills"][0]
    assert (s["version"], s["level"], s["verification"]["version"], s["verification"]["current"]) == (2, 4, 1, False)
    with pytest.raises(psycopg.errors.SerializationFailure):
        as_(api, w, w.editor2, "select pulse.skill_verify(%s,1,4,null)", (sid,))
    # A note alone is not a new version.
    claim(api, w, w.editor, w.editor, shoot, level=4, note="Synthetic: led the August shoots")
    assert profile(api, w, w.editor, w.editor)["skills"][0]["version"] == 2
    as_(api, w, w.lead, "select pulse.skill_verify(%s,2,4,null)", (sid,))
    v = profile(api, w, w.editor, w.editor)["skills"][0]["verification"]
    assert (v["basis"], v["current"], v["level"]) == ("hr", True, 4)
    # Even a direct write cannot make the person their own verifier.
    with owner.transaction():
        set_tenant(owner, w.org)
        with pytest.raises(psycopg.errors.InsufficientPrivilege, match="their own"):
            owner.execute("insert into pulse.skill_verification(org_id,skill_id,claim_version,level,verifier_id,basis) values(%s,%s,2,4,%s,'hr')",
                          (w.org, sid, w.editor))
    # Withdrawal: the verifier or HR, nobody else.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.skill_verify_withdraw(%s)", (v["id"],))
    as_(api, w, w.lead, "select pulse.skill_verify_withdraw(%s)", (v["id"],))
    assert profile(api, w, w.editor, w.editor)["skills"][0]["verification"]["version"] == 1
    # Experience: the person's entry, an RE project only if they worked on it, confirmed per version.
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="worked on"):
        as_(api, w, w.editor, "select pulse.experience_save(%s,null,%s)", (w.editor, Jsonb({"title": "Shoot lead", "started": "2025-03", "projectId": str(w.project)})))
    eid = one(api, w, w.editor, "select pulse.experience_save(%s,null,%s) id", (w.editor, Jsonb({
        "title": "Shoot lead", "started": "2025-03", "responsibilities": "Synthetic: ran model shoots", "outcomes": "Synthetic: 12 reels delivered"})))["id"]
    claim(api, w, w.editor, w.editor, shoot, level=4, evidence=[{"kind": "experience", "id": str(eid)}])
    assert profile(api, w, w.editor, w.editor)["skills"][0]["evidence"][0]["state"] == "claimed"
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.experience_confirm(%s,1,null)", (eid,))
    as_(api, w, w.editor2, "select pulse.experience_confirm(%s,1,'Synthetic: confirmed')", (eid,))
    p = profile(api, w, w.editor, w.editor)
    assert p["experience"][0]["confirmed"]["current"] is True and p["skills"][0]["evidence"][0]["state"] == "approved"
    as_(api, w, w.editor, "select pulse.experience_save(%s,%s,%s)", (w.editor, eid, Jsonb({"title": "Shoot lead", "started": "2025-03", "outcomes": "Synthetic: 15 reels"})))
    p = profile(api, w, w.editor, w.editor)
    assert p["experience"][0]["version"] == 2 and p["experience"][0]["confirmed"]["current"] is False
    assert p["skills"][0]["evidence"][0]["state"] == "claimed"
    # The scale: Pulse's starting four until HR confirms; levels can be renamed or added, never removed.
    assert p["rubric"]["confirmed"] is False and len(p["rubric"]["levels"]) == 4
    five = [{"label": f"Level {i}", "description": f"Synthetic description of level {i}."} for i in range(1, 6)]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.skill_rubric_set(%s)", (Jsonb(five),))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="not removed"):
        as_(api, w, w.lead, "select pulse.skill_rubric_set(%s)", (Jsonb(five[:3]),))
    as_(api, w, w.lead, "select pulse.skill_rubric_set(%s)", (Jsonb(five),))
    r = profile(api, w, w.editor, w.editor)["rubric"]
    assert r["confirmed"] is True and [x["label"] for x in r["levels"]] == [f"Level {i}" for i in range(1, 6)]
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="not removed"):
        as_(api, w, w.lead, "select pulse.skill_rubric_set(%s)", (Jsonb(five[:4]),))


def test_reviewed_cv_is_restricted_logged_and_stays_as_reviewed(api, worker, owner, team, tmp_path):  # noqa: F811
    w = team
    esco_v1(worker, w, tmp_path)
    edit = concept(api, w, S["edit"])["id"]
    shoot = local_skill(api, w)
    done = accepted_task(api, w, "Synthetic launch reel")
    a = claim(api, w, w.editor, w.editor, edit, level=3, evidence=[{"kind": "task", "id": str(done)}])
    claim(api, w, w.editor, w.editor, shoot, level=2)
    as_(api, w, w.editor2, "select pulse.skill_verify(%s,1,3,null)", (a,))
    eid = one(api, w, w.editor, "select pulse.experience_save(%s,null,%s) id", (w.editor, Jsonb({"title": "Shoot lead", "started": "2025-03"})))["id"]
    # The draft is the person's only.
    for who in (w.editor2, w.lead, w.manager):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            as_(api, w, who, "select pulse.resume_draft(%s)", (w.editor,))
    assert one(api, w, w.editor2, "select pulse.resume_read(%s) r", (w.editor,))["r"]["reviewed"] is None
    d = one(api, w, w.editor, "select pulse.resume_draft(%s,%s) d", (w.editor, Jsonb({"headline": "Synthetic video editor", "summary": "Synthetic summary"})))["d"]
    body = d["body"]
    assert set(body) == {"person", "headline", "summary", "skills", "experience", "scale", "attribution"}
    assert set(body["person"]) == {"name", "role", "team", "pod", "joined"}
    verified = {s["label"]: s for s in body["skills"]}
    assert verified["edit video footage"]["verified"]["basis"] == "manager" and verified["edit video footage"]["approvedWork"] == ["Synthetic launch reel"]
    assert verified["Model shoot direction"]["verified"] is None and verified["Model shoot direction"]["local"] is True
    assert body["attribution"] == [ESCO_ATTRIBUTION] and body["scale"]["confirmed"] is False
    assert [e["title"] for e in body["experience"]] == ["Shoot lead"] and body["experience"][0]["confirmed"] is None
    # Review: exactly what the person read; then only that version is readable by others.
    choice = {"headline": "Synthetic video editor", "summary": "Synthetic summary", "skills": [str(a)], "experience": [str(eid)]}
    with pytest.raises(psycopg.errors.SerializationFailure):
        as_(api, w, w.editor, "select pulse.resume_review(%s,%s)", (w.editor, Jsonb({**choice, "sha256": d["sha256"]})))
    d2 = one(api, w, w.editor, "select pulse.resume_draft(%s,%s) d", (w.editor, Jsonb(choice)))["d"]
    r = one(api, w, w.editor, "select pulse.resume_review(%s,%s) r", (w.editor, Jsonb({**choice, "sha256": d2["sha256"]})))["r"]
    assert r["version"] == 1 and r["sha256"] == d2["sha256"]
    for who in (w.editor2, w.lead):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            as_(api, w, who, "select pulse.resume_review(%s,%s)", (w.editor, Jsonb({**choice, "sha256": d2["sha256"]})))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.outsider, "select pulse.resume_read(%s)", (w.editor,))
    seen = one(api, w, w.editor2, "select pulse.resume_read(%s) r", (w.editor,))["r"]
    assert seen["reviewed"]["version"] == 1 and [s["label"] for s in seen["reviewed"]["body"]["skills"]] == ["edit video footage"]
    assert seen["changedSince"] is None and seen["openedBy"] is None
    one(api, w, w.lead, "select pulse.resume_read(%s,'export') r", (w.editor,))
    one(api, w, w.manager, "select pulse.resume_read(%s) r", (w.editor,))
    # The person changes a level: others still read what was reviewed; the person is told it changed, and who opened it.
    claim(api, w, w.editor, w.editor, edit, level=4, evidence=[{"kind": "task", "id": str(done)}])
    assert one(api, w, w.editor2, "select pulse.resume_read(%s) r", (w.editor,))["r"]["reviewed"]["body"]["skills"][0]["level"] == 3
    mine = one(api, w, w.editor, "select pulse.resume_read(%s) r", (w.editor,))["r"]
    assert mine["changedSince"] is True
    assert sorted({(o["by"], o["purpose"]) for o in mine["openedBy"]}) == [("Editor Two", "resume_view"), ("Pod Manager", "resume_view"), ("Project Lead", "resume_export")]
    with owner.transaction():
        set_tenant(owner, w.org)
        logged = owner.execute("select viewer_id from privacy.access_log where subject_person_id=%s and resource='people.resume'", (w.editor,)).fetchall()
    assert w.editor not in {x["viewer_id"] for x in logged} and len(logged) == 4
    # Another company: its admin reads nothing of this person and finds none of these skills.
    other = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, other.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2026-01-01')", (other.org, other.manager))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, other, other.manager, "select pulse.skill_profile(%s)", (w.editor,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, other, other.manager, "select pulse.resume_read(%s)", (w.editor,))
    assert catalog(api, other, other.manager, "video")["items"] == [] and catalog(api, other, other.manager, "video")["sources"] == []



def test_http_picker_claims_verification_and_cv_export(worker, owner, api, team, tmp_path):  # noqa: F811
    """services/api/test/skills-runner.mjs: the same rules over HTTP with real password sessions."""
    w = team
    esco_v1(worker, w, tmp_path)
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        for pid in (w.manager, w.editor, w.editor2, w.lead, w.outsider):
            api.execute("select pulse.login_issue(%s,'Synthetic-issued-2026!')", (pid,))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    proc = subprocess.run(["node", "test/skills-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api",
                          env={**os.environ, "TEST_API_CONFIG": json.dumps(config), "PULSE_ORG_ID": str(w.org), "TEST_EDITOR": str(w.editor),
                               "TEST_ESCO_EDIT": S["edit"]}, capture_output=True, text=True, timeout=120, check=False)
    assert proc.returncode == 0, proc.stderr + proc.stdout


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_skills_pages_in_the_browser(worker, owner, api, team, tmp_path):  # noqa: F811
    """services/api/test/skills-browser-runner.mjs: add a skill, keep the CV, verify, open it; screenshots with PULSE_R48_SCREENSHOTS."""
    w = team
    esco_v1(worker, w, tmp_path)
    edit = concept(api, w, S["edit"])["id"]
    as_(api, w, w.lead, "select pulse.skill_alias_add(%s,'वीडियो एडिटिंग','hi')", (edit,))
    shoot = local_skill(api, w)
    done = accepted_task(api, w, "Synthetic launch reel")
    a = claim(api, w, w.editor, w.editor, edit, level=3, since="2025-04", evidence=[{"kind": "task", "id": str(done)}])
    claim(api, w, w.editor, w.editor, shoot, level=2)
    as_(api, w, w.editor2, "select pulse.skill_verify(%s,1,2,'Synthetic: saw two launches')", (a,))
    one(api, w, w.editor, "select pulse.experience_save(%s,null,%s) id", (w.editor, Jsonb({"title": "Shoot lead", "started": "2025-03", "outcomes": "Synthetic: 12 reels"})))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config), "PULSE_R48_REPORT": str(tmp_path / "r48.json"),
           "TEST_IDS": json.dumps({"editor": str(w.editor), "editorEmail": w.editor_handle, "headEmail": f"editor2@{w.domain}"})}
    p = subprocess.run(["node", "test/skills-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=2400, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-6000:]
    assert json.loads((tmp_path / "r48.json").read_text())["browserChecks"] >= 30
