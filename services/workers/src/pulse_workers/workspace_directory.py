"""Refresh observed groups/aliases atomically. Pulse membership mappings are explicit and survive refresh."""

import json
import os
import subprocess
from pathlib import Path

from psycopg.types.json import Jsonb

from pulse_sdk.db import active_orgs, connect, tenant_tx

# Explicit defaults for the owner's named groups; no functional/team-role inference from job titles.
MAPPING = {
    "team": ("all", None),
    "leadership": ("role", "admin,leadership"),
    "pod1": ("pod", "Pod 1"),
    "pod2": ("pod", "Pod 2"),
    "pgs": ("role", "pgs,head_pgs,manager"),
}


def apply(c, org, snapshot):
    with tenant_tx(c, org):
        for group in snapshot["groups"]:
            kind, value = MAPPING.get(group["address"].split("@")[0], (None, None))
            # Exact existing department matching is a mapping, not a guessed role or membership.
            if kind is None:
                local = group["address"].split("@")[0]
                teams = c.execute(
                    "select distinct department from pulse.people_profile where lower(department)=%s", (local,)
                ).fetchall()
                if len(teams) == 1:
                    kind, value = "team", teams[0]["department"]
            c.execute(
                """insert into pulse.workspace_group(org_id,address,name,aliases,members,source_kind,source_value)
              values(%s,%s,%s,%s,%s,%s,%s) on conflict(org_id,address)
              do update set name=excluded.name,aliases=excluded.aliases,
              members=excluded.members,observed_at=now()""",
                (org, group["address"], group["name"], group["aliases"], Jsonb(group["members"]), kind, value),
            )
        c.execute(
            "delete from pulse.workspace_group where not(address=any(%s))",
            ([g["address"] for g in snapshot["groups"]],),
        )
        for alias in snapshot["aliases"]:
            c.execute(
                """insert into pulse.workspace_alias(org_id,address,primary_address,kind,editable)
              values(%s,%s,%s,%s,%s)
              on conflict(org_id,address) do update set primary_address=excluded.primary_address,kind=excluded.kind,
              editable=excluded.editable,observed_at=now()""",
                (org, alias["address"], alias["primary"], alias["kind"], alias.get("editable", True)),
            )
        c.execute(
            "delete from pulse.workspace_alias where not(address=any(%s))",
            ([a["address"] for a in snapshot["aliases"]],),
        )
        c.execute(
            """insert into pulse.sync_run(org_id,source,started_at,finished_at,ok,upstream_at,stats)
            values(%s,'workspace_directory',now(),now(),true,now(),%s)""",
            (org, Jsonb({"groups": len(snapshot["groups"]), "aliases": len(snapshot["aliases"])})),
        )
    return {"groups": len(snapshot["groups"]), "aliases": len(snapshot["aliases"])}


def main():
    script = Path(__file__).resolve().parents[4] / "tools/workspace-directory.py"
    proc = subprocess.run(
        [os.environ.get("PULSE_GOOGLE_PYTHON", "/home/eadev/ea-intel/venv/bin/python"), str(script)],
        capture_output=True,
        text=True,
        timeout=240,
        check=False,
    )
    if proc.returncode:
        with connect("worker") as c:
            for org in active_orgs(c):
                with tenant_tx(c, org):
                    c.execute(
                        """insert into pulse.sync_run(org_id,source,started_at,finished_at,ok,error)
                        values(%s,'workspace_directory',now(),now(),false,
                        'Directory read unavailable; check delegated read-only scopes')""",
                        (org,),
                    )
        raise SystemExit("Directory read unavailable; prior snapshot retained.")
    snapshot = json.loads(proc.stdout)
    with connect("worker") as c:
        print(json.dumps([apply(c, org, snapshot) for org in active_orgs(c)]))


if __name__ == "__main__":
    main()
