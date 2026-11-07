"""Synthetic tenants and event emitters for the Event Core tests. Never real people's data."""

from __future__ import annotations

import hashlib
import itertools
import random
import re
import string
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import psycopg
from psycopg.types.json import Jsonb

from pulse_sdk import registry as reg
from pulse_sdk.db import set_tenant
from pulse_sdk.envelope import make_event, to_row
from pulse_sdk.signing import generate_keypair
from pulse_sdk.store import StoreResult, insert_event
from pulse_sdk.ulid import new_ulid
from pulse_sdk.validate import EventValidator

REGISTRY = reg.default()
VALIDATOR = EventValidator(REGISTRY)
FOLDER_MIME = "application/vnd.google-apps.folder"
_codes = itertools.count()

FOLDER_RULES = {     # appendix C excerpt (first tenant's folder rules), semantics appendix F.1
    "storage": "gdrive",
    "roots": "bound",
    "project_paths": [
        {"match": r"(?i)(?:^|/)Client Video Shoot/(?P<year>20\d{2})/(?P<month>[^/]+)/(?P<project>[^/]+)(?:/|$)"},
    ],
    "subfolders": [
        {"match": "video editing details", "role": "input:edit_brief"},
        {"match": "project blueprint", "role": "input:blueprint_folder", "nested": True},
        {"match": r"research(\s+and)?\s+scripts?", "role": "input:research"},
        {"match": r"(shoot\s+)?raw(\s+(files|footage))?|shoot raw files", "role": "input:raw_footage"},
        {"match": r"model\s+final\s+videos?(\s+and)?(\s+its)?\s+hooks?|final\s+videos?(\s+and\s+hooks?)?",
         "role": "deliverables", "default_version_kind": "final"},
        {"match": r"vovs?(\s+and\s+designs?)?", "role": "deliverables", "default_version_kind": "final"},
        {"match": "creatives?", "role": "deliverables", "default_version_kind": "final"},
        {"match": "drafts?", "role": "deliverables", "default_version_kind": "draft", "nested": True},
        {"match": "leads?", "role": "ignore"},
    ],
}
VIDEO_EDITOR_PACK = {"label": "Video Editor", "deliverable_types": [
    {"code": c, "key": k} for c, k in (("MV", "model_video"), ("HK", "hook"), ("VV", "vov"), ("WT", "walkthrough"))]}
NOTICE_PURPOSES = ["delivery", "quality", "coaching", "workload", "outcomes", "activity_context", "presence"]


def new_code() -> str:
    n = next(_codes)
    letters = random.choice("BCDFGHJKLMNPQRSTVWXZ") + string.ascii_uppercase[n % 26] + \
        string.ascii_uppercase[(n // 26) % 26] + random.choice(string.ascii_uppercase)
    return letters


def md5_of(text: str) -> str:
    return hashlib.md5(text.encode()).hexdigest()


def sha256_of(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def drive_id() -> str:
    return "1" + "".join(random.choice(string.ascii_letters + string.digits) for _ in range(20))


@dataclass
class World:
    org: uuid.UUID
    code: str
    domain: str
    instance: str
    editor: uuid.UUID
    editor2: uuid.UUID
    lead: uuid.UUID
    manager: uuid.UUID
    pod: uuid.UUID
    project: uuid.UUID
    registry_no: int
    root: str
    drafts: str
    finals: str
    leads_folder: str
    device: uuid.UUID
    device2: uuid.UUID
    device_keys: dict = field(default_factory=dict)
    shared_handle: str = ""
    editor_handle: str = ""
    t0: datetime = field(default_factory=lambda: datetime.now(timezone.utc) - timedelta(days=2))

    def at(self, minutes: float) -> datetime:
        return self.t0 + timedelta(minutes=minutes)

    @property
    def collector(self) -> str:
        return f"/collectors/gdrive_audit/1/{self.instance}"

    @property
    def changes(self) -> str:
        return f"/collectors/gdrive_changes/1/{self.instance}"

    def cid(self, type_code: str = "HK", num: int = 3) -> str:
        return f"{self.code}{self.registry_no:04d}-{type_code}{num:02d}"


def event(org, type_: str, subject: str, data: dict, *, source: str, time: datetime, actor: str | None = None,
          purpose: str | None = None, visibility: str | None = None, sensitivity: int | None = None,
          id: str | None = None, **ext) -> dict:
    et = REGISTRY.get(type_)
    return make_event(
        org_id=org, id=id or new_ulid(time), source=source, type=type_, time=time, subject=subject,
        purpose=purpose if purpose is not None else et.purposes[0],
        sensitivity=sensitivity if sensitivity is not None else et.sensitivity,
        visibility=visibility or et.visibility, data=data, actor=actor,
        actorkind=actor.split(":")[0] if actor else None, **ext)


def read_as(conn: psycopg.Connection, org, sql: str, params: tuple = ()) -> list[dict]:
    """Rows of one tenant through any connection (row-level security applies to every Pulse role)."""
    with conn.transaction():
        set_tenant(conn, org)
        return conn.execute(sql, params).fetchall()


def store(conn: psycopg.Connection, ev: dict, *, check: bool = True) -> StoreResult:
    if check:
        errors = VALIDATOR.errors(ev)
        assert not errors, errors
    row = to_row(ev)
    with conn.transaction():
        set_tenant(conn, row["org_id"])
        return insert_event(conn, row, REGISTRY)


def emit(conn: psycopg.Connection, org, type_: str, subject: str, data: dict, **kw) -> StoreResult:
    result = store(conn, event(org, type_, subject, data, **kw))
    assert result.status in ("accepted", "duplicate"), result
    return result


def build_world(worker: psycopg.Connection, owner: psycopg.Connection, api: psycopg.Connection,
                *, code: str | None = None, notice: bool = True) -> World:
    org = uuid.uuid4()
    code = code or new_code()
    domain = f"{code.lower()}.example"
    w = World(org=org, code=code, domain=domain, instance=f"ws-{code.lower()}", editor=uuid.uuid4(),
              editor2=uuid.uuid4(), lead=uuid.uuid4(), manager=uuid.uuid4(), pod=uuid.uuid4(), project=uuid.uuid4(),
              registry_no=random.randint(100, 9999), root=drive_id(), drafts=drive_id(), finals=drive_id(),
              leads_folder=drive_id(), device=uuid.uuid4(), device2=uuid.uuid4(),
              shared_handle=f"shoot@{domain}", editor_handle=f"editor1@{domain}")
    with worker.transaction():
        set_tenant(worker, org)
        worker.execute("insert into pulse.org (id, slug, name, code) values (%s, %s, %s, %s)",
                       (org, f"org-{org}", f"Synthetic {code}", code))
        for pid, name in ((w.editor, "Editor One"), (w.editor2, "Editor Two"), (w.lead, "Project Lead"),
                          (w.manager, "Pod Manager")):
            worker.execute("insert into pulse.person (id, org_id, display_name, side) values (%s, %s, %s, 'staff')",
                           (pid, org, name))
        worker.execute("insert into pulse.unit (id, org_id, kind, name) values (%s, %s, 'pod', 'Pod 1')", (w.pod, org))
        for pid, role, mgr in ((w.editor, "video_editor", False), (w.editor2, "video_editor", False),
                               (w.manager, "head_pgs", True), (w.lead, "pgs", False)):
            worker.execute("""insert into pulse.role_assignment (org_id, person_id, unit_id, role_key,
                                                                 is_manager_of_unit, valid_from)
                              values (%s, %s, %s, %s, %s, '2026-01-01')""", (org, pid, w.pod, role, mgr))
        worker.execute("""insert into pulse.account (org_id, provider, handle, is_shared) values (%s, 'google', %s, true)""",
                       (org, w.shared_handle))
        worker.execute("""insert into pulse.account (org_id, provider, handle, holder_person_id)
                          values (%s, 'google', %s, %s)""", (org, w.editor_handle, w.editor))
        for dev, person in ((w.device, w.editor), (w.device2, w.editor2)):
            key, pub = generate_keypair()
            w.device_keys[dev] = key
            worker.execute("""insert into pulse.device (id, org_id, default_person_id, platform, public_key)
                              values (%s, %s, %s, 'windows', %s)""", (dev, org, person, pub))
        worker.execute("""insert into pulse.project (id, org_id, registry_no, name, lead_person_id, storage_root)
                          values (%s, %s, %s, 'Pilot project', %s, %s)""",
                       (w.project, org, w.registry_no, w.lead, f"gdrive:{w.root}"))
        for kind, key, body in (("folder_rules", "default", FOLDER_RULES), ("role_pack", "video_editor", VIDEO_EDITOR_PACK)):
            worker.execute("""insert into pulse.tenant_config (org_id, doc_kind, doc_key, version, body, is_active)
                              values (%s, %s, %s, 1, %s, true)""", (org, kind, key, Jsonb(body)))
    with owner.transaction():
        owner_role = owner.execute(
            "select pg_get_userbyid(nspowner) as owner_role from pg_namespace where nspname='pulse'"
        ).fetchone()["owner_role"]
        if not re.fullmatch(r"[a-z_][a-z0-9_]*", owner_role):
            raise AssertionError("unexpected pulse schema owner role")
        owner.execute(f"set local role {owner_role}")
        if owner.execute("select pulse.install_org() as org_id").fetchone()["org_id"] is None:
            owner.execute("insert into pulse.install(org_id,initialised_by) values(%s,'test:synthetic')", (org,))
    if notice:
        with owner.transaction():
            set_tenant(owner, org)
            owner.execute("""insert into privacy.notice (org_id, id, language, body_md, purposes, published_at)
                             values (%s, 'staff-v1', 'en', 'Synthetic staff notice', %s, now() - interval '30 days')""",
                          (org, NOTICE_PURPOSES))
        with api.transaction():
            set_tenant(api, org)
            for pid in (w.editor, w.editor2, w.lead, w.manager):
                api.execute("""insert into privacy.notice_ack (org_id, person_id, notice_id, language, acknowledged_at,
                                                               channel)
                               values (%s, %s, 'staff-v1', 'en', now() - interval '20 days', 'web')""", (org, pid))
    # Bind the project root and create the stage folders (as the API and the Drive collector would).
    emit(api, org, "project.bound", f"project:pulse:{w.project}",
         {"registry_no": w.registry_no, "storage_root": f"gdrive:{w.root}"}, source="/api/web", time=w.at(0))
    for fid, name in ((w.drafts, "8) Drafts"), (w.finals, "5) Model Final Videos & Its Hooks"),
                      (w.leads_folder, "Leads")):
        emit(worker, org, "drive.folder.created", f"file:gdrive:{fid}",
             {"name": name, "mime": FOLDER_MIME, "parents": [w.root]}, source=w.changes, time=w.at(1))
    return w


def issue_asset(api: psycopg.Connection, w: World, cid: str, *, task: uuid.UUID | None = None,
                minutes: float = 2) -> uuid.UUID:
    asset = uuid.uuid4()
    data = {"cid": cid, "deliverable_type": cid.split("-")[1][:2], "project_ref": f"project:pulse:{w.project}",
            "issued_by": "api"}
    if task:
        data["task_ref"] = f"task:pulse:{task}"
    emit(api, w.org, "asset.issued", f"asset:pulse:{asset}", data, source="/api/web", time=w.at(minutes))
    return asset


def create_task(api: psycopg.Connection, w: World, assignee: uuid.UUID, *, minutes: float = 2,
                dtype: str = "HK") -> uuid.UUID:
    task = uuid.uuid4()
    emit(api, w.org, "task.created", f"task:pulse:{task}",
         {"project_ref": f"project:pulse:{w.project}", "title": "Hook edit", "assignee_ref": f"person:pulse:{assignee}",
          "deliverable_type": dtype}, source="/api/web", time=w.at(minutes))
    return task


def render(conn: psycopg.Connection, w: World, device: uuid.UUID, name: str, content: str, *, minutes: float,
           cid: str | None = None) -> StoreResult:
    data = {"name": name, "size": len(content) * 1000, "md5": md5_of(content), "sha256": sha256_of(content)}
    if cid:
        data["cid"] = cid
    return emit(conn, w.org, "agent.render.detected", f"file:local:{name}", data, source=f"/agent/{device}",
                actor=f"device:pulse:{device}", time=w.at(minutes))


def upload(conn: psycopg.Connection, w: World, file_id: str, name: str, content: str, *, folder: str, minutes: float,
           actor: str | None = None, type_: str = "drive.file.uploaded", mime: str = "video/mp4") -> StoreResult:
    return emit(conn, w.org, type_, f"file:gdrive:{file_id}",
                {"name": name, "mime": mime, "parents": [folder], "md5": md5_of(content), "size": len(content) * 1000},
                source=w.collector, actor=actor or f"account:google:{w.shared_handle}", time=w.at(minutes))
