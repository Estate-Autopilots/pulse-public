"""The work-graph projection: folders, files, tasks, assets, versions and attribution from the log (02 §2, §4, §5;
03 §9; appendix F.1).

Identity rules this projection guarantees:
- one Drive file is one ``file`` row (uuid v5 of store and id) however many events mention it;
- one asset per issued CID; a file or render whose name carries the CID joins that asset, its ``-vN`` picks the
  version, and without ``-vN`` versions are numbered in arrival order;
- the same bytes are the same version: a Drive upload and a render on an editor's computer with the same MD5 meet in
  one version of one asset, whichever arrives first (a legacy-named asset created in the meantime is merged into
  the CID asset);
- a media file in a deliverables folder without a known CID becomes a legacy asset keyed by its Drive file id.
Evidence queries only look at events up to the one being applied, so an incremental run and a rebuild see the same
history at every step and produce identical rows (no clock reads; ``decided_at`` is the applied event's time).
"""

from __future__ import annotations

import re
import uuid
from datetime import date, timedelta
from typing import Any

import psycopg
from psycopg.types.json import Jsonb
from pulse_rules.folder_rules import load

from pulse_sdk import cid as cidlib
from pulse_sdk.identity import IdentityMap, device_from_source
from pulse_sdk.ids import entity_id, parse_ref, ref_uuid

from . import resolver
from .consumer import Event
from .projector import Projection
from .rules import is_media, normalise

FOLDER_MIME = "application/vnd.google-apps.folder"
DRIVE_FILE_TYPES = {"drive.file.created", "drive.file.uploaded", "drive.file.updated", "drive.file.moved",
                    "drive.file.renamed", "drive.file.trashed", "drive.file.observed", "drive.file.shared"}
DELIVERY_TYPES = ("drive.file.created", "drive.file.uploaded", "drive.file.observed")
LOCAL_OUTPUT_TYPES = {"agent.render.detected", "app.export.completed", "app.render.completed"}
TASK_TYPES = {"task.created", "task.assigned", "task.status_changed", "task.due_changed"}
EXISTENCE = {"cid_name": 0.95, "legacy_name": 0.75, "render_hash": 0.90, "plugin_export": 0.85}
EXPORT_WINDOW = timedelta(hours=12)
TRASH_CONTRADICTS = timedelta(hours=1)


class WorkGraph(Projection):
    name = "workgraph"
    version = 3
    tables = ("pulse.ad_metric_day", "pulse.ad", "pulse.ad_set", "pulse.campaign", "pulse.attribution",
              "pulse.version", "pulse.asset", "pulse.task", "pulse.file", "pulse.folder")

    # ----------------------------------------------------------------------------------------------- set-up
    def begin(self, conn: psycopg.Connection, org_id: uuid.UUID) -> None:
        self.conn = conn
        self.org = org_id
        self.ids = IdentityMap(conn)
        self.org_code = self._one("select code from pulse.org where id = %s", (org_id,))["code"]
        self.rules = load(conn, org_id).folder_rules
        self.producers: dict[str, set[str]] = {}
        for r in self._all("select doc_key, body from pulse.tenant_config where doc_kind = 'role_pack' and is_active"):
            codes = {str(t.get("code")) for t in (r["body"] or {}).get("deliverable_types", []) if t.get("code")}
            if codes:
                self.producers[r["doc_key"]] = codes

    def _one(self, sql: str, params: tuple = ()) -> dict | None:
        return self.conn.execute(sql, params).fetchone()

    def _all(self, sql: str, params: tuple = ()) -> list[dict]:
        return self.conn.execute(sql, params).fetchall()

    def _upto(self) -> str:
        """SQL predicate: events at or before the one being applied (same history in incremental and rebuild)."""
        return f"(tx_id, seq) <= ('{self.ev.tx}'::xid8, {self.ev.seq})"

    # ------------------------------------------------------------------------------------------------ apply
    def apply(self, conn: psycopg.Connection, event: Event) -> None:
        self.ev = event
        if event.redacted:          # redacted events carry no data: nothing structural can be derived from them
            return
        t = event.type
        if t == "project.bound":
            self._bind_root(event)
        elif t == "drive.folder.created" or (t in DRIVE_FILE_TYPES and event.data.get("mime") == FOLDER_MIME):
            self._folder(event)
        elif t in DRIVE_FILE_TYPES:
            self._drive_file(event)
        elif t in LOCAL_OUTPUT_TYPES:
            self._local_output(event)
        elif t in TASK_TYPES:
            self._task(event)
        elif t == "asset.issued":
            self._asset_issued(event)
        elif t == "ads.metrics.daily":
            self._ads_metric(event)
        elif t in ("attribution.confirmed", "attribution.rejected"):
            seq = (parse_ref(event.subject) or ("", "", ""))[2]
            if seq.isdigit():
                for r in self._all("select version_id from pulse.attribution where event_seq = %s and version_id "
                                   "is not null", (int(seq),)):
                    self._refresh(r["version_id"])
        elif t == "leave.declared":
            start, end = _date(event.data.get("from")), _date(event.data.get("to"))
            if start and end:
                for r in self._all("""select distinct version_id from pulse.attribution
                                       where version_id is not null and event_time::date between %s and %s
                                       order by version_id""", (start, end)):
                    self._refresh(r["version_id"])

    # ---------------------------------------------------------------------------------------------- folders
    def _bind_root(self, ev: Event) -> None:
        project_id = ref_uuid(ev.subject, "project")
        root = str(ev.data.get("storage_root") or "")
        if not project_id or not root.startswith("gdrive:"):
            return
        if not self._one("select 1 from pulse.project where id = %s", (project_id,)):
            return
        store_id = root.split(":", 1)[1]
        self.conn.execute(
            """insert into pulse.folder (org_id, store, store_id, project_id, path, role, last_seq)
               values (pulse.current_org(), 'gdrive', %s, %s, '{}', 'root', %s)
               on conflict (org_id, store, store_id) do update
                 set project_id = excluded.project_id, path = '{}', role = 'root', version_kind = null,
                     last_seq = excluded.last_seq""",
            (store_id, project_id, ev.seq),
        )
        self._reclassify_subtree(store_id)

    def _folder(self, ev: Event) -> None:
        store_id = _drive_key(ev.subject)
        if not store_id:
            return
        data = ev.data
        owner = parse_ref(data.get("owner"))
        owner_account = self.ids.account_id(owner[1], owner[2]) if owner and owner[0] == "account" else None
        self.conn.execute(
            """insert into pulse.folder (org_id, store, store_id, parent_store_id, name, owner_account_id,
                                          trashed, last_seq)
               values (pulse.current_org(), 'gdrive', %s, %s, %s, %s, %s, %s)
               on conflict (org_id, store, store_id) do update
                 set parent_store_id = coalesce(excluded.parent_store_id, pulse.folder.parent_store_id),
                     name = coalesce(excluded.name, pulse.folder.name),
                     owner_account_id = coalesce(excluded.owner_account_id, pulse.folder.owner_account_id),
                     trashed = pulse.folder.trashed or excluded.trashed, last_seq = excluded.last_seq""",
            (store_id, _parent(data), data.get("name"), owner_account,
             ev.type == "drive.file.trashed", ev.seq),
        )
        self._reclassify_subtree(store_id)

    def _classify_folder(self, store_id: str) -> None:
        row = self._one("select * from pulse.folder where store = 'gdrive' and store_id = %s", (store_id,))
        if row is None or row["role"] == "root":
            return
        names, cur, seen = [], row, set()
        while cur is not None and cur["role"] != "root":
            names.append(normalise(cur["name"]))
            parent = cur["parent_store_id"]
            if parent is None or parent in seen:
                cur = None
                break
            seen.add(cur["store_id"])
            cur = self._one("select * from pulse.folder where store = 'gdrive' and store_id = %s", (parent,))
        if cur is None:
            project, path, role, kind = None, None, None, None
        else:
            path = list(reversed(names))
            project = cur["project_id"]
            role, kind = self.rules.classify(path)
        self.conn.execute(
            """update pulse.folder set project_id = %s, path = %s, role = %s, version_kind = %s
                where store = 'gdrive' and store_id = %s""",
            (project, path, role, kind, store_id),
        )

    def _reclassify_subtree(self, store_id: str) -> None:
        queue, seen = [store_id], set()
        while queue:
            current = queue.pop(0)
            if current in seen:
                continue
            seen.add(current)
            self._classify_folder(current)
            queue.extend(r["store_id"] for r in self._all(
                "select store_id from pulse.folder where store = 'gdrive' and parent_store_id = %s order by store_id",
                (current,)))
        for f in self._all("""select * from pulse.file where store = 'gdrive' and parent_store_id = any(%s)
                              order by id""", (sorted(seen),)):
            self._detect(f)

    # ------------------------------------------------------------------------------------------------ files
    def _drive_file(self, ev: Event) -> None:
        store_id = _drive_key(ev.subject)
        if not store_id:
            return
        d = ev.data
        fid = entity_id(self.org, "file", "gdrive", store_id)
        self.conn.execute(
            """insert into pulse.file (id, org_id, store, store_id, name, mime, size_bytes, md5, sha256, duration_ms,
                                       width, height, parent_store_id, created_at, trashed_at, first_seq, last_seq)
               values (%(id)s, pulse.current_org(), 'gdrive', %(sid)s, %(name)s, %(mime)s, %(size)s, %(md5)s,
                       %(sha256)s, %(dur)s, %(w)s, %(h)s, %(parent)s, %(time)s, %(trashed)s, %(seq)s, %(seq)s)
               on conflict (id) do update set
                 name = coalesce(excluded.name, pulse.file.name), mime = coalesce(excluded.mime, pulse.file.mime),
                 size_bytes = coalesce(excluded.size_bytes, pulse.file.size_bytes),
                 md5 = coalesce(excluded.md5, pulse.file.md5), sha256 = coalesce(excluded.sha256, pulse.file.sha256),
                 duration_ms = coalesce(excluded.duration_ms, pulse.file.duration_ms),
                 width = coalesce(excluded.width, pulse.file.width),
                 height = coalesce(excluded.height, pulse.file.height),
                 parent_store_id = coalesce(excluded.parent_store_id, pulse.file.parent_store_id),
                 trashed_at = coalesce(pulse.file.trashed_at, excluded.trashed_at),
                 last_seq = excluded.last_seq""",
            {"id": fid, "sid": store_id, "name": d.get("name"), "mime": d.get("mime"), "size": _int(d.get("size")),
             "md5": _hash(d.get("md5")), "sha256": _hash(d.get("sha256")), "dur": _int(d.get("duration_ms")),
             "w": _int(d.get("width")), "h": _int(d.get("height")), "parent": _parent(d), "time": ev.time,
             "trashed": ev.time if ev.type == "drive.file.trashed" else None, "seq": ev.seq},
        )
        self._detect(self._one("select * from pulse.file where id = %s", (fid,)))

    def _detect(self, f: dict) -> None:
        """Decide which asset and version a Drive file is (or none) and link it."""
        folder = self._one("select * from pulse.folder where store = 'gdrive' and store_id = %s",
                           (f["parent_store_id"],)) if f["parent_store_id"] else None
        role = folder["role"] if folder else None
        kind = (folder["version_kind"] if folder else None) or "draft"
        project = folder["project_id"] if folder else None
        current = self._one("select * from pulse.version where file_id = %s", (f["id"],))
        if role == "ignore":
            return
        parsed = cidlib.parse(f["name"])
        asset = self._issued_asset(parsed)
        target = None
        if asset is not None:
            if current is not None and current["asset_id"] == asset["id"]:
                target = current
            elif parsed.version is not None:
                target = self._version(asset, parsed.version, parsed.variant, kind, f["created_at"])
            elif f["md5"] and (v := self._one("select * from pulse.version where asset_id = %s and md5 = %s "
                                              "order by version_no limit 1", (asset["id"], f["md5"]))):
                target = v
            else:
                target = self._version(asset, self._next_no(asset["id"], parsed.variant), parsed.variant, kind,
                                       f["created_at"])
        elif f["md5"] and (v := self._version_by_md5(f["md5"])):
            target = v
        elif current is not None:
            target = current
        elif role == "deliverables" and is_media(f["mime"], f["name"]):
            legacy = self._legacy_asset(f, project)
            target = self._version(legacy, 1, None, kind, f["created_at"])
        if target is None:
            return
        if current is not None and current["id"] != target["id"]:
            self.conn.execute("update pulse.version set file_id = null where id = %s", (current["id"],))
            self._drop_if_orphan_legacy(current)
        self.conn.execute(
            """update pulse.version set file_id = coalesce(file_id, %s), md5 = coalesce(md5, %s),
                      created_at = least(created_at, %s), kind = case when %s then %s else kind end
                where id = %s""",
            (f["id"], f["md5"], f["created_at"], role == "deliverables", kind, target["id"]),
        )
        self._merge_same_bytes(target["id"])
        self._refresh(target["id"])

    def _local_output(self, ev: Event) -> None:
        """A render or export on an enrolled computer (S7-S11): joins the version with the same bytes or the CID."""
        d = ev.data
        name = d.get("name") or d.get("output_name") or (parse_ref(ev.subject) or ("", "", ""))[2]
        md5 = _hash(d.get("md5"))
        parsed = cidlib.parse(d.get("cid")) or cidlib.parse(name)
        asset = self._issued_asset(parsed)
        target = self._version_by_md5(md5) if md5 else None
        if asset is not None:
            if target is not None and target["asset_id"] != asset["id"]:
                legacy = self._one("select * from pulse.asset where id = %s", (target["asset_id"],))
                if legacy and legacy["cid"] is None:       # same bytes as a legacy-named upload: the CID wins
                    target = self._version(asset, parsed.version or self._next_no(asset["id"], parsed.variant),
                                           parsed.variant, "draft", ev.time, md5)
            elif target is None and parsed.version is not None:
                target = self._version(asset, parsed.version, parsed.variant, "draft", ev.time, md5)
            elif target is None and md5:
                target = self._version(asset, self._next_no(asset["id"], parsed.variant), parsed.variant, "draft",
                                       ev.time, md5)
        if target is not None:
            if md5:
                self.conn.execute("update pulse.version set md5 = coalesce(md5, %s) where id = %s",
                                  (md5, target["id"]))
            self._merge_same_bytes(target["id"])
            self._refresh(target["id"])
        elif asset is not None:      # an export without hash or version: evidence for the asset's delivered versions
            for v in self._all("select id from pulse.version where asset_id = %s and file_id is not null "
                               "order by version_no, variant nulls first", (asset["id"],)):
                self._refresh(v["id"])

    # ------------------------------------------------------------------------------------------ tasks, assets
    def _task(self, ev: Event) -> None:
        task_id = ref_uuid(ev.subject, "task")
        if task_id is None:
            return
        d = ev.data
        assignee = ref_uuid(d.get("assignee_ref"), "person")
        if assignee and not self._one("select 1 from pulse.person where id = %s", (assignee,)):
            assignee = None
        project = ref_uuid(d.get("project_ref"), "project")
        if project and not self._one("select 1 from pulse.project where id = %s", (project,)):
            project = None
        status = d.get("status") if ev.type == "task.status_changed" else None
        self.conn.execute(
            """insert into pulse.task (id, org_id, project_id, title, assignee_person_id, deliverable_type,
                                       planned_units, assigned_at, due_at, status)
               values (%(id)s, pulse.current_org(), %(project)s, coalesce(%(title)s, ''), %(assignee)s, %(dtype)s,
                       %(units)s, case when %(assignee)s::uuid is not null then %(time)s end, %(due)s,
                       coalesce(%(status)s, 'open'))
               on conflict (id) do update set
                 project_id = coalesce(excluded.project_id, pulse.task.project_id),
                 title = case when excluded.title <> '' then excluded.title else pulse.task.title end,
                 assignee_person_id = coalesce(excluded.assignee_person_id, pulse.task.assignee_person_id),
                 assigned_at = case when excluded.assignee_person_id is distinct from pulse.task.assignee_person_id
                                     and excluded.assignee_person_id is not null then excluded.assigned_at
                                    else pulse.task.assigned_at end,
                 deliverable_type = coalesce(excluded.deliverable_type, pulse.task.deliverable_type),
                 planned_units = coalesce(excluded.planned_units, pulse.task.planned_units),
                 due_at = coalesce(excluded.due_at, pulse.task.due_at),
                 status = coalesce(%(status)s, pulse.task.status)""",
            {"id": task_id, "project": project, "title": d.get("title"), "assignee": assignee,
             "dtype": d.get("deliverable_type"), "units": d.get("planned_units"), "time": ev.time,
             "due": d.get("due_at"), "status": status if status in _TASK_STATUS else None},
        )
        for v in self._all("""select v.id from pulse.version v join pulse.asset a on a.id = v.asset_id
                               where a.task_id = %s and v.file_id is not null order by v.id""", (task_id,)):
            self._refresh(v["id"])

    def _asset_issued(self, ev: Event) -> None:
        asset_id = ref_uuid(ev.subject, "asset")
        parsed = cidlib.parse(ev.data.get("cid"))
        if asset_id is None or parsed is None or parsed.tenant != self.org_code:
            return
        project = ref_uuid(ev.data.get("project_ref"), "project")
        if not project or not self._one("select 1 from pulse.project where id = %s and registry_no = %s",
                                        (project, parsed.project)):
            return
        task = ref_uuid(ev.data.get("task_ref"), "task")
        if task and not self._one("select 1 from pulse.task where id = %s", (task,)):
            task = None
        issued_by = ev.data.get("issued_by") if ev.data.get("issued_by") in ("api", "detection", "import") else "api"
        self.conn.execute(
            """insert into pulse.asset (id, org_id, project_id, task_id, cid, deliverable_type, issued_by, first_seq)
               values (%s, pulse.current_org(), %s, %s, %s, %s, %s, %s)
               on conflict (id) do update set task_id = coalesce(excluded.task_id, pulse.asset.task_id)""",
            (asset_id, project, task, parsed.base, ev.data.get("deliverable_type") or parsed.type_code, issued_by,
             ev.seq),
        )
        self._link_ads_for_cid(parsed.base)
        # Files and renders that carried this CID before it was issued were treated as legacy names: look again.
        like = parsed.base.replace("_", r"\_").replace("%", r"\%") + "%"
        for f in self._all("select * from pulse.file where name like %s order by id", (like,)):
            if (p := cidlib.parse(f["name"])) and p.base == parsed.base:
                self._detect(f)
        for r in self._all(
                f"""select seq, tx_id::text as tx, id, source, type, time, recorded_at, subject, actor, actor_kind,
                           project_id, data, purpose, redacted_at
                      from pulse.event where org_id = pulse.current_org() and {self._upto()}
                       and type in ('agent.render.detected', 'app.export.completed', 'app.render.completed')
                       and redacted_at is null and (data->>'cid' like %s or data->>'name' like %s
                            or data->>'output_name' like %s)
                     order by tx_id, seq""", (like, like, like)):
            saved = self.ev
            self._local_output(Event(seq=r["seq"], tx=int(r["tx"]), id=r["id"], source=r["source"], type=r["type"],
                                     time=r["time"], recorded_at=r["recorded_at"], subject=r["subject"],
                                     actor=r["actor"], actor_kind=r["actor_kind"], project_id=r["project_id"],
                                     data=r["data"] or {}, purpose=list(r["purpose"]), redacted=False))
            self.ev = saved

    def _ads_metric(self, ev: Event) -> None:
        d = ev.data
        project_id = None
        match = re.match(re.escape(self.org_code) + r"(\d{4,6})(?:$|[\s_-])", d["campaign_name"])
        if match:
            project = self._one("select id from pulse.project where registry_no = %s", (int(match.group(1)),))
            project_id = project["id"] if project else None

        campaign_id = entity_id(self.org, "campaign", "meta", d["platform_campaign_id"])
        ad_set_id = entity_id(self.org, "ad_set", "meta", d["platform_campaign_id"], d["platform_ad_set_id"])
        ad_id = entity_id(self.org, "ad", "meta", d["platform_ad_set_id"], d["platform_ad_id"])
        self.conn.execute(
            """insert into pulse.campaign (id, org_id, platform, platform_id, ad_account, project_id, name)
               values (%s, pulse.current_org(), 'meta', %s, %s, %s, %s)
               on conflict (org_id, platform, platform_id) do update set
                 ad_account = excluded.ad_account,
                 project_id = coalesce(excluded.project_id, pulse.campaign.project_id),
                 name = excluded.name""",
            (campaign_id, d["platform_campaign_id"], d["ad_account"], project_id, d["campaign_name"]),
        )
        self.conn.execute(
            """insert into pulse.ad_set (id, org_id, campaign_id, platform_id, name)
               values (%s, pulse.current_org(), %s, %s, %s)
               on conflict (org_id, campaign_id, platform_id) do update set name = excluded.name""",
            (ad_set_id, campaign_id, d["platform_ad_set_id"], d.get("ad_set_name")),
        )
        cid = d.get("cid")
        version_id = self._cid_version(cid, d.get("cid_version"), d.get("cid_variant"))
        self.conn.execute(
            """insert into pulse.ad (id, org_id, ad_set_id, platform_id, name, cid, version_id, link_method)
               values (%s, pulse.current_org(), %s, %s, %s, %s, %s, %s)
               on conflict (org_id, ad_set_id, platform_id) do update set
                 name = excluded.name, cid = excluded.cid, version_id = excluded.version_id,
                 link_method = excluded.link_method""",
            (ad_id, ad_set_id, d["platform_ad_id"], d["ad_name"], cid, version_id,
             "cid" if cid else "unresolved"),
        )
        self.conn.execute(
            """insert into pulse.ad_metric_day (org_id, ad_id, day, placement, spend, currency, impressions, reach,
                       video_3s_plays, thruplays, link_clicks, leads, attribution_setting, link_ctr, leads_reported,
                       pulled_at)
               values (pulse.current_org(), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               on conflict (org_id, ad_id, day, placement) do update set
                 spend = excluded.spend, currency = excluded.currency, impressions = excluded.impressions,
                 reach = excluded.reach, video_3s_plays = excluded.video_3s_plays,
                 thruplays = excluded.thruplays, link_clicks = excluded.link_clicks, leads = excluded.leads,
                 attribution_setting = excluded.attribution_setting, link_ctr = excluded.link_ctr,
                 leads_reported = excluded.leads_reported, pulled_at = excluded.pulled_at
               where excluded.pulled_at >= pulse.ad_metric_day.pulled_at""",
            (ad_id, d["day"], d["placement"], d["spend"], d["currency"], d["impressions"], d.get("reach"),
             d.get("video_3s_plays"), d.get("thruplays"), d.get("link_clicks"), d.get("leads"),
             d["attribution_setting"], d.get("link_ctr"), d["leads_reported"], ev.recorded_at),
        )

    def _cid_version(self, cid: str | None, version_no: int | None, variant: str | None) -> uuid.UUID | None:
        if not cid:
            return None
        asset = self._one("select id from pulse.asset where org_id = pulse.current_org() and cid = %s", (cid,))
        if asset is None or version_no is None:
            return None
        version = self._one("""select id from pulse.version where org_id = pulse.current_org() and asset_id = %s
                               and version_no = %s and variant is not distinct from %s""",
                            (asset["id"], version_no, variant))
        return version["id"] if version else None

    def _link_ads_for_cid(self, cid: str) -> None:
        for ad in self._all("select id, name from pulse.ad where org_id = pulse.current_org() and cid = %s",
                            (cid,)):
            parsed = cidlib.parse_prefix(ad["name"])
            version_id = None
            if parsed and parsed.base == cid:
                version_id = self._cid_version(cid, parsed.version, parsed.variant)
            self.conn.execute("update pulse.ad set link_method = 'cid', version_id = %s where id = %s",
                              (version_id, ad["id"]))

    # --------------------------------------------------------------------------------------- version helpers
    def _issued_asset(self, parsed: cidlib.Cid | None) -> dict | None:
        if parsed is None or parsed.tenant != self.org_code:
            return None
        return self._one("select * from pulse.asset where cid = %s", (parsed.base,))

    def _version_by_md5(self, md5: str | None) -> dict | None:
        if not md5:
            return None
        # Prefer a version of a CID asset over a legacy one, then the oldest.
        return self._one("""select v.* from pulse.version v join pulse.asset a on a.id = v.asset_id
                             where v.md5 = %s order by (a.cid is null), v.created_at, v.id limit 1""", (md5,))

    def _next_no(self, asset_id: uuid.UUID, variant: str | None) -> int:
        row = self._one("select coalesce(max(version_no), 0) + 1 as n from pulse.version "
                        "where asset_id = %s and variant is not distinct from %s", (asset_id, variant))
        return row["n"]

    def _version(self, asset: dict, version_no: int, variant: str | None, kind: str, created_at,
                 md5: str | None = None) -> dict:
        vid = entity_id(self.org, "version", asset["id"], version_no, variant)
        self.conn.execute(
            """insert into pulse.version (id, org_id, asset_id, version_no, variant, kind, md5, created_at)
               values (%s, pulse.current_org(), %s, %s, %s, %s, %s, %s)
               on conflict (id) do update set md5 = coalesce(pulse.version.md5, excluded.md5),
                                              created_at = least(pulse.version.created_at, excluded.created_at)""",
            (vid, asset["id"], version_no, variant, kind if kind in _VERSION_KINDS else "draft", md5, created_at),
        )
        if asset.get("cid"):
            self._link_ads_for_cid(asset["cid"])
        return self._one("select * from pulse.version where id = %s", (vid,))

    def _legacy_asset(self, f: dict, project: uuid.UUID | None) -> dict:
        key = f"file:gdrive:{f['store_id']}"
        aid = entity_id(self.org, "asset", key)
        self.conn.execute(
            """insert into pulse.asset (id, org_id, project_id, legacy_key, deliverable_type, issued_by, first_seq)
               values (%s, pulse.current_org(), %s, %s, 'unknown', 'detection', %s)
               on conflict (id) do update set project_id = coalesce(excluded.project_id, pulse.asset.project_id)""",
            (aid, project, key, self.ev.seq),
        )
        return self._one("select * from pulse.asset where id = %s", (aid,))

    def _merge_same_bytes(self, version_id: uuid.UUID) -> None:
        """Fold legacy versions with the same MD5 into this version (one file seen twice = one asset)."""
        if self.ev.type == "drive.file.observed" and self.ev.source == "/collectors/gdrive_snapshot/1/ea-index":
            return  # The read-only snapshot stopgap never deletes historical versions or attribution evidence.
        v = self._one("select v.*, a.cid from pulse.version v join pulse.asset a on a.id = v.asset_id where v.id = %s",
                      (version_id,))
        if v is None or not v["md5"] or v["cid"] is None:
            return
        for dup in self._all("""select v.* from pulse.version v join pulse.asset a on a.id = v.asset_id
                                 where v.md5 = %s and v.id <> %s and a.cid is null order by v.id""",
                             (v["md5"], version_id)):
            self.conn.execute("delete from pulse.attribution where version_id = %s", (dup["id"],))
            self.conn.execute("update pulse.version set file_id = null where id = %s", (dup["id"],))
            self.conn.execute("update pulse.version set file_id = coalesce(file_id, %s), "
                              "created_at = least(created_at, %s) where id = %s",
                              (dup["file_id"], dup["created_at"], version_id))
            self.conn.execute("delete from pulse.version where id = %s", (dup["id"],))
            self._drop_if_orphan_legacy(dup)

    def _drop_if_orphan_legacy(self, version: dict) -> None:
        if self.ev.type == "drive.file.observed" and self.ev.source == "/collectors/gdrive_snapshot/1/ea-index":
            return  # Snapshot refreshes preserve historical records; only authoritative events can remove them.
        a = self._one("select * from pulse.asset where id = %s", (version["asset_id"],))
        if a is None or a["cid"] is not None:
            return
        if version["file_id"] is None and self._one("select 1 from pulse.version where id = %s and file_id is null",
                                                   (version["id"],)):
            self.conn.execute("delete from pulse.attribution where version_id = %s", (version["id"],))
            self.conn.execute("delete from pulse.version where id = %s", (version["id"],))
        if not self._one("select 1 from pulse.version where asset_id = %s", (a["id"],)):
            self.conn.execute("delete from pulse.asset where id = %s", (a["id"],))

    # ------------------------------------------------------------------------------ existence and attribution
    def _opaque_evidence_id(self, seq: int, group: str) -> str:
        """Stable tenant-scoped evidence reference; never includes the event payload or a person identifier."""
        return f"ev1_{uuid.uuid5(self.org, f'delivery-attribution/v1:{seq}:{group}').hex}"

    def _attribution_evidence(self, items: list[dict], sources: dict[tuple[uuid.UUID, str], set[str]],
                              delivery_seq: int, declared_seq: int | None,
                              credited_person: uuid.UUID | None) -> list[dict[str, str]]:
        """Persist only opaque evidence IDs, their rule group and explanation, never candidate/person values."""
        stored: dict[str, dict[str, str]] = {}
        for item in items:
            group = item.get("group")
            raw_person = item.get("person")
            person = uuid.UUID(raw_person) if isinstance(raw_person, str) else None
            if credited_person is not None and person is not None and person != credited_person:
                continue
            if group in ("account_map", "shared_account"):
                evidence_ids = {self._opaque_evidence_id(delivery_seq, group)}
            elif group == "declared":
                evidence_ids = ({self._opaque_evidence_id(declared_seq, group)}
                                if declared_seq is not None else set())
            elif group == "fingerprint" and person is not None:
                evidence_ids = sources.get((person, "hash"), set()) | sources.get((person, "export"), set())
            elif person is not None and group:
                evidence_ids = sources.get((person, group), set())
            else:
                evidence_ids = set()
            how = item.get("how")
            if not how:
                continue
            for evidence_id in sorted(evidence_ids):
                stored.setdefault(evidence_id, {"id": evidence_id, "group": group, "how": how})
        return list(stored.values())

    def _refresh(self, version_id: uuid.UUID) -> None:
        v = self._one("""select v.*, a.cid, a.task_id, a.deliverable_type from pulse.version v
                          join pulse.asset a on a.id = v.asset_id where v.id = %s""", (version_id,))
        if v is None:
            return
        f = self._one("select * from pulse.file where id = %s", (v["file_id"],)) if v["file_id"] else None
        self._existence(v, f)
        if f is not None:
            self._attribute(v, f)

    def _existence(self, v: dict, f: dict | None) -> None:
        signals: dict[str, Any] = {}
        if f is not None:
            folder = self._one("select role from pulse.folder where store = 'gdrive' and store_id = %s",
                               (f["parent_store_id"],)) if f["parent_store_id"] else None
            if folder and folder["role"] == "deliverables":
                parsed = cidlib.parse(f["name"])
                signals["cid_name" if parsed and v["cid"] == parsed.base else "legacy_name"] = True
        if v["md5"] and self._one(f"""select 1 from pulse.event where org_id = pulse.current_org() and {self._upto()}
                                       and type = 'agent.render.detected' and redacted_at is null
                                       and data->>'md5' = %s limit 1""", (v["md5"],)):
            signals["render_hash"] = True
        if v["cid"]:
            names = [n for n in (f["name"] if f else None, ) if n]
            cids = [v["cid"], f"{v['cid']}-v{v['version_no']}"]
            if self._one(f"""select 1 from pulse.event where org_id = pulse.current_org() and {self._upto()}
                              and type in ('app.export.completed', 'app.render.completed') and redacted_at is null
                              and (data->>'cid' = any(%s) or data->>'output_name' = any(%s)) limit 1""",
                         (cids, names)):
                signals["plugin_export"] = True
        miss = 1.0
        for key in signals:
            miss *= 1.0 - EXISTENCE[key]
        confidence = 1.0 - miss
        if f is not None and f["trashed_at"] is not None and f["created_at"] is not None \
                and f["trashed_at"] - f["created_at"] <= TRASH_CONTRADICTS:
            confidence, signals["contradicted"] = 0.0, "trashed within 1 h"
        self.conn.execute("update pulse.version set existence_confidence = %s, evidence = %s where id = %s",
                          (round(confidence, 3), Jsonb(signals), v["id"]))

    def _attribute(self, v: dict, f: dict) -> None:
        subject = f"file:gdrive:{f['store_id']}"
        delivery = self._one(f"""select seq, time, actor, data from pulse.event
                                  where org_id = pulse.current_org() and {self._upto()} and subject = %s
                                    and type = any(%s) and redacted_at is null
                                  order by time, seq limit 1""", (subject, list(DELIVERY_TYPES)))
        if delivery is None:
            return
        when = delivery["time"]
        signals: list[resolver.Signal] = []
        evidence_sources: dict[tuple[uuid.UUID, str], set[str]] = {}

        def add_signal(person: uuid.UUID, group: str, ratio: float, seq: int) -> None:
            signals.append(resolver.Signal(person, group, ratio))
            evidence_sources.setdefault((person, group), set()).add(self._opaque_evidence_id(seq, group))

        data = delivery["data"] or {}
        actor = delivery["actor"] or data.get("last_modifying_user") or data.get("owner")
        who = self.ids.person_for(actor, when)
        if who.kind == "account" and who.person_id and not who.shared:
            add_signal(who.person_id, "uploader", resolver.LIKELIHOOD["uploader"], delivery["seq"])
        account_map_person = None
        shared_account = who.kind == "account" and who.shared
        actor_ref = parse_ref(actor)
        if actor_ref and actor_ref[0] == "account":
            account_map_person = self.ids.account_person(actor_ref[1], actor_ref[2], when)
        if v["md5"]:
            for r in self._all(f"""select seq, source, time from pulse.event where org_id = pulse.current_org()
                                    and {self._upto()} and type = 'agent.render.detected' and redacted_at is null
                                    and data->>'md5' = %s order by tx_id, seq""", (v["md5"],)):
                person = self.ids.device_person(device_from_source(r["source"]), r["time"])
                if person:
                    add_signal(person, "hash", resolver.LIKELIHOOD["hash"], r["seq"])
        cids = [c for c in (v["cid"], f"{v['cid']}-v{v['version_no']}" if v["cid"] else None) if c]
        for r in self._all(f"""select seq, source, time from pulse.event where org_id = pulse.current_org()
                                and {self._upto()} and type in ('app.export.completed', 'app.render.completed')
                                and redacted_at is null and time between %s and %s
                                and (data->>'output_name' = %s or data->>'cid' = any(%s)) order by tx_id, seq""",
                           (when - EXPORT_WINDOW, when, f["name"], cids)):
            person = self.ids.device_person(device_from_source(r["source"]), r["time"])
            if person:
                add_signal(person, "export", resolver.LIKELIHOOD["export"], r["seq"])
        if f["parent_store_id"]:
            parent = f["parent_store_id"]
            visited = set()
            while parent and parent not in visited:
                visited.add(parent)
                folder = self._one("""select parent_store_id, role, owner_account_id, last_seq from pulse.folder
                                      where store = 'gdrive' and store_id = %s""", (parent,))
                if not folder:
                    break
                if folder["role"] == "deliverables" and folder["owner_account_id"]:
                    owner = self._one("select provider, handle from pulse.account where id = %s",
                                      (folder["owner_account_id"],))
                    if owner:
                        person = self.ids.account_person(owner["provider"], owner["handle"], when)
                        if person:
                            add_signal(person, "folder_owner", resolver.LIKELIHOOD["folder_owner"],
                                       folder["last_seq"])
                    break
                if folder["role"] == "root":
                    break
                parent = folder["parent_store_id"]
        assignee = None
        if v["task_id"]:
            t = self._one("select assignee_person_id from pulse.task where id = %s", (v["task_id"],))
            assignee = t["assignee_person_id"] if t else None
            if assignee:
                signals.append(resolver.Signal(assignee, "cid_owner", resolver.LIKELIHOOD["cid_owner"]))
        declared, declared_seq, rejected = None, None, set()
        for r in self._all(f"""select seq, type, data from pulse.event
                                where org_id = pulse.current_org() and {self._upto()}
                                  and subject = %s and type in ('attribution.confirmed', 'attribution.rejected')
                                and redacted_at is null order by tx_id, seq""", (f"event:pulse:{delivery['seq']}",)):
            person = ref_uuid(r["data"].get("person_ref"), "person")
            if person and r["type"] == "attribution.confirmed":
                declared = person
                declared_seq = r["seq"]
                rejected.discard(person)
            elif person:
                rejected.add(person)
                if declared == person:
                    declared = None
                    declared_seq = None
        candidates = self._candidates(v["deliverable_type"], when)
        eligible = self._eligible(candidates | {s.person for s in signals} | ({assignee} if assignee else set()))
        signals = [s for s in signals if s.person in eligible]
        on_leave = self._on_leave(eligible, when)
        decision = resolver.decide(eligible, signals, assignee=assignee if assignee in eligible else None,
                                   declared=declared, rejected=rejected,
                                   on_leave=on_leave, account_map_person=account_map_person
                                   if account_map_person in eligible else None, shared_account=shared_account)
        evidence = self._attribution_evidence(decision.evidence, evidence_sources, delivery["seq"], declared_seq,
                                              decision.person if decision.credited else None)
        self.conn.execute(
            """insert into pulse.attribution (org_id, event_seq, event_time, version_id, person_id, probability, method,
                                              resolver_version, evidence, decided_at)
               values (pulse.current_org(), %s, %s, %s, %s, %s, %s, %s, %s, %s)
               on conflict (org_id, event_seq, resolver_version) do update set
                 version_id = excluded.version_id, person_id = excluded.person_id, probability = excluded.probability,
                 method = excluded.method, evidence = excluded.evidence, decided_at = excluded.decided_at""",
            (delivery["seq"], when, v["id"], decision.person, decision.probability, decision.method, resolver.VERSION,
             Jsonb(evidence), self.ev.time),
        )
        self.conn.execute("update pulse.version set creator_person_id = %s, attribution_p = %s where id = %s",
                          (decision.person if decision.credited else None, decision.probability, v["id"]))

    def _candidates(self, deliverable_type: str, when) -> set[uuid.UUID]:
        """Persons whose role pack can produce this deliverable type, assigned on that day."""
        roles = [role for role, codes in self.producers.items()
                 if deliverable_type in codes or deliverable_type == "unknown"]
        if not roles:
            return set()
        rows = self._all("""select distinct person_id from pulse.role_assignment
                             where role_key = any(%s) and valid_from <= %s::date
                               and (valid_to is null or valid_to >= %s::date)""", (roles, when, when))
        return {r["person_id"] for r in rows}

    def _eligible(self, people: set[uuid.UUID]) -> set[uuid.UUID]:
        if not people:
            return set()
        rows = self._all("select id from pulse.person where id = any(%s) and status = 'active' "
                         "and not tracking_excluded", (sorted(people),))
        return {r["id"] for r in rows}

    def _on_leave(self, people: set[uuid.UUID], when) -> set[uuid.UUID]:
        if not people:
            return set()
        subjects = [f"person:pulse:{p}" for p in sorted(people)]
        # A malformed date in someone's leave event must not break attribution for everyone: safe_date gives null.
        rows = self._all(f"""select subject from pulse.event where org_id = pulse.current_org() and {self._upto()}
                              and type = 'leave.declared' and redacted_at is null and subject = any(%s)
                              and coalesce(pulse.safe_date(data->>'from') <= %s::date
                                           and pulse.safe_date(data->>'to') >= %s::date, false)""",
                         (subjects, when, when))
        return {ref_uuid(r["subject"], "person") for r in rows}


_TASK_STATUS = {"open", "in_progress", "blocked", "in_review", "done", "cancelled"}
_VERSION_KINDS = {"draft", "revision", "final", "variant", "reupload"}


def _date(value) -> str | None:
    """An ISO date string, or None when the value is not a valid calendar date."""
    if not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        return None


def _drive_key(subject: str) -> str | None:
    parsed = parse_ref(subject)
    if not parsed or parsed[0] != "file" or parsed[1] != "gdrive":
        return None
    return parsed[2]


def _parent(data: dict) -> str | None:
    parents = data.get("parents")
    if not isinstance(parents, list) or not parents:
        return None
    p = str(parents[0])
    return p.split(":", 1)[1] if p.startswith("gdrive:") else p


def _hash(value) -> str | None:
    return value.lower() if isinstance(value, str) and value else None


def _int(value) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None
