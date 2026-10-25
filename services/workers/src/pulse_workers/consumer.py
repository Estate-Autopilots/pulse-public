"""Reading the log safely (05 §6).

Sequence numbers are assigned at insert but transactions commit in another order, so consumers read only rows whose
transaction is older than the active-XID bound from the statement snapshot and keep a cursor on (tx_id, seq). A
snapshot is cluster-wide; skip only XIDs pg_stat_activity identifies as running in another database, which cannot
write this database's log. Unknown XIDs still hold the cursor conservatively. Both log tables are read together.
Runs inside a tenant transaction.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import psycopg

_COLS = "seq, tx_id::text as tx, id, source, type, time, recorded_at, subject, actor, actor_kind, project_id, data, " \
        "purpose, redacted_at"

READ_SQL = f"""
with snapshot as materialized (
  select pg_current_snapshot() as value
)
select * from (
  select {_COLS} from pulse.event where org_id = pulse.current_org()
  union all
  select {_COLS} from pulse.event_ephemeral where org_id = pulse.current_org()
) e
where (tx::xid8, seq) > (%(last_tx)s::xid8, %(last_seq)s)
  and tx::xid8 < coalesce(
    (select min(active.xid)
       from snapshot s cross join lateral pg_snapshot_xip(s.value) as active(xid)
      where not exists (
        select 1 from pg_stat_activity a
         where a.backend_xid = active.xid::xid
           and a.datid <> (select oid from pg_database where datname = current_database())
      )),
    (select pg_snapshot_xmax(value) from snapshot)
  )
order by tx::xid8, seq
limit %(limit)s
"""


@dataclass(frozen=True)
class Event:
    seq: int
    tx: int
    id: str
    source: str
    type: str
    time: datetime
    recorded_at: datetime
    subject: str
    actor: str | None
    actor_kind: str | None
    project_id: uuid.UUID | None
    data: dict[str, Any]
    purpose: list[str]
    redacted: bool

    @property
    def position(self) -> tuple[int, int]:
        return self.tx, self.seq


def read_batch(conn: psycopg.Connection, last_tx: int, last_seq: int, limit: int = 1000) -> list[Event]:
    rows = conn.execute(READ_SQL, {"last_tx": str(last_tx), "last_seq": last_seq, "limit": limit}).fetchall()
    return [
        Event(seq=r["seq"], tx=int(r["tx"]), id=r["id"], source=r["source"], type=r["type"], time=r["time"],
              recorded_at=r["recorded_at"], subject=r["subject"], actor=r["actor"], actor_kind=r["actor_kind"],
              project_id=r["project_id"], data=r["data"] or {}, purpose=list(r["purpose"] or ()),
              redacted=r["redacted_at"] is not None)
        for r in rows
    ]
