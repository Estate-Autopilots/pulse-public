"""Replayable delivery view of indexed file snapshots; shared logins never imply a person."""
from __future__ import annotations

import re
from datetime import datetime

from pulse_rules.folder_rules import FolderRuleSet, load

from pulse_sdk.ids import entity_id

from .projector import Projection
from .rules import is_media, normalise


def classify(path: str, rules: FolderRuleSet) -> tuple[str, str, str] | None:
    segments = [normalise(p) for p in path.split("/")[:-1]]
    for pattern in rules.exclusions:
        if any(re.search(r"\b(?:" + pattern + r")\b", segment, re.I) for segment in segments):
            return None
    for rule in rules.index_rules:
        for segment in segments:
            if rule.pattern.fullmatch(segment):
                return rule.kind, segment, rule.doc_key
    return None


class Deliveries(Projection):
    name = "indexed-deliveries"
    version = 1
    tables = ("pulse.delivery", "pulse.index_version", "pulse.index_file")

    def begin(self, conn, org_id):
        self.conn, self.org = conn, org_id
        self.projects = {r["storage_root"].removeprefix("index-path:"): r["id"] for r in conn.execute(
            "select id,storage_root from pulse.project where storage_root like 'index-path:%'")}
        self.rules = load(conn, org_id)

    def apply(self, conn, event):
        if event.type != "drive.file.observed" or event.redacted or "index_path" not in event.data:
            return
        d = event.data
        fid = event.subject.removeprefix("file:gdrive:")
        path = d["index_path"]
        project = None
        # Exact path-boundary match; longest wins in nested engagements.
        for root in sorted(self.projects, key=len, reverse=True):
            if path.startswith(root + "/"):
                project = self.projects[root]
                break
        account = d.get("last_modifying_user") or d.get("owner")
        account = account.removeprefix("account:google:") if account else None
        basis = "last modifying account" if d.get("last_modifying_user") else "owner only; uploader unknown"
        created, modified = d.get("index_created_at"), d.get("index_modified_at")
        conn.execute("""insert into pulse.index_file(org_id,file_id,name,mime,path,project_id,uploader_account,
                        account_basis,created_at,modified_at,observed_at,event_seq)
                        values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                        on conflict(org_id,file_id) do update set name=excluded.name,mime=excluded.mime,
                        path=excluded.path,project_id=excluded.project_id,uploader_account=excluded.uploader_account,
                        account_basis=excluded.account_basis,created_at=excluded.created_at,
                        modified_at=excluded.modified_at,observed_at=excluded.observed_at,event_seq=excluded.event_seq""",
                     (self.org, fid, d["name"], d["mime"], path, project, account, basis,
                      created, modified, event.time, event.seq))
        if modified:
            conn.execute("insert into pulse.index_version(org_id,file_id,modified_at,event_seq,observed_at) "
                         "values (%s,%s,%s,%s,%s) on conflict do nothing",
                         (self.org, fid, modified, event.seq, event.time))
        match = classify(path, self.rules) if project and is_media(d["mime"], d["name"]) else None
        if match and (modified or created):
            kind, segment, doc_key = match
            detail = (f"Media in configured '{segment}' folder; one current record per Drive file. "
                      f"Date is latest indexed modification, not an upload audit. Account is {basis}.")
            conn.execute("""insert into pulse.delivery(org_id,file_id,project_id,uploader_account,kind,
                             delivered_at,rule,rule_detail,event_seq) values (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                             on conflict(org_id,file_id) do update set project_id=excluded.project_id,
                             uploader_account=excluded.uploader_account,kind=excluded.kind,
                             delivered_at=excluded.delivered_at,rule_detail=excluded.rule_detail,
                             event_seq=excluded.event_seq""",
                         (self.org, fid, project, account, kind, modified or created,
                          doc_key, detail, event.seq))
            # Core assets and versions agree with the indexed delivery view.
            asset = entity_id(self.org, "asset", f"file:gdrive:{fid}")
            file_id = entity_id(self.org, "file", "gdrive", fid)
            conn.execute("""insert into pulse.file(id,org_id,store,store_id,name,mime,created_at,first_seq,last_seq)
                             values (%s,%s,'gdrive',%s,%s,%s,%s,%s,%s) on conflict(id) do nothing""",
                         (file_id, self.org, fid, d["name"], d["mime"], created or event.time, event.seq, event.seq))
            stored_asset = conn.execute("""insert into pulse.asset(id,org_id,project_id,legacy_key,
                             deliverable_type,title,
                             issued_by,first_seq) values (%s,%s,%s,%s,'video',%s,'import',%s)
                             on conflict(org_id,legacy_key) do update set project_id=excluded.project_id
                             returning id""",
                         (asset, self.org, project, f"file:gdrive:{fid}", d["name"], event.seq)).fetchone()
            asset = stored_asset["id"]
            # No historical revisions are invented: v1 represents the latest indexed file.
            version = entity_id(self.org, "version", asset, 1, None)
            conn.execute("""insert into pulse.version(id,org_id,asset_id,version_no,kind,file_id,created_at,evidence)
                             values (%s,%s,%s,1,%s,%s,%s,'{"source":"drive_index","history":"snapshot only"}')
                             on conflict(id) do update set kind=excluded.kind""",
                         (version, self.org, asset, kind, file_id, created or datetime.fromisoformat(modified)))
        elif event.source != "/collectors/gdrive_snapshot/1/ea-index":
            conn.execute("delete from pulse.delivery where org_id=%s and file_id=%s", (self.org, fid))
        # A metadata snapshot is evidence that a file was seen, not an authoritative retraction of a delivery.
        # Keep the previous delivery if it moved out of a matching folder; claims and evidence remain attached.
