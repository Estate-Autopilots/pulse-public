# ruff: noqa: E501
"""FIN-ENTRY: payment screenshots found in the WhatsApp index, offered in Finance → Entries → Found in WhatsApp.

Reads ea_index (wa.payment_screens joined to wa.attachments, wa.messages and wa.groups) on a read-only transaction and
copies one row per screenshot into pulse.fin_wa_screen with a small thumbnail fetched read-only from Drive (the
indexer service account, drive.readonly). Nothing is ever written to ea_index or to Drive; what Finance does with a
screenshot lives in pulse.fin_wa_decision and is never touched here.

    python -m pulse_workers.finance_live wa-screens --org UUID [--no-images] [--limit-images N] [--refresh-images]
"""

from __future__ import annotations

import re

SUBJECT = "admin@estateautopilots.com"
QUERY = """
select p.sha256, p.amounts, p.max_amount, coalesce(p.transaction_ids,'{}') transaction_ids, coalesce(p.dates_in_text,'{}') dates_in_text,
       p.payee_hint, x.drive_file_id, x.ts, x.sender_name, x.sender_role, x.text, x.title, x.client_name_in_title
from wa.payment_screens p
left join lateral (
  select coalesce(a.primary_drive->>'drive_file_id', a.drive->0->>'drive_file_id') drive_file_id, m.ts, m.sender_name, m.sender_role,
         left(m.text, 600) text, g.title, g.client_name_in_title
  from wa.attachments a
  left join wa.messages m on m.message_id = a.message_id
  left join wa.groups g on g.group_id = coalesce(m.group_id, a.group_id)
  where a.sha256 = p.sha256
  order by m.ts asc nulls last, a.attachment_id
  limit 1) x on true
"""
UPSERT = """
insert into pulse.fin_wa_screen(org_id,sha256,amount,amounts,transaction_ids,dates_in_text,payee,sent_at,sender,sender_role,message_text,group_title,client_hint,drive_file_id,synced_at)
values(%(org)s,%(sha256)s,%(amount)s,%(amounts)s,%(transaction_ids)s,%(dates_in_text)s,%(payee)s,%(sent_at)s,%(sender)s,%(sender_role)s,%(message_text)s,%(group_title)s,%(client_hint)s,%(drive_file_id)s,now())
on conflict(org_id,sha256) do update set amount=excluded.amount,amounts=excluded.amounts,transaction_ids=excluded.transaction_ids,
 dates_in_text=excluded.dates_in_text,payee=excluded.payee,sent_at=excluded.sent_at,sender=excluded.sender,sender_role=excluded.sender_role,
 message_text=excluded.message_text,group_title=excluded.group_title,client_hint=excluded.client_hint,drive_file_id=excluded.drive_file_id,synced_at=now()
"""

# Phone references the indexer pseudonymised ("@[phone ph_…]") stay out of Finance.
PHONE = re.compile(r"@\[phone [^\]]*\]\s*")


def _clip(value, n):
    if value is None:
        return None
    text = PHONE.sub("", str(value)).strip()
    return text[:n] or None


def rows_from_index(index) -> list[dict]:
    with index.transaction():
        index.execute("set transaction read only")
        out = []
        for r in index.execute(QUERY).fetchall():
            amount = r["max_amount"]
            if amount is not None and not (0 < float(amount) < 1e11):
                amount = None
            out.append({
                "sha256": r["sha256"], "amount": amount,
                "amounts": [a for a in (r["amounts"] or []) if a is not None and 0 < float(a) < 1e11][:20],
                "transaction_ids": [str(t)[:80] for t in r["transaction_ids"]][:10],
                "dates_in_text": [str(t)[:40] for t in r["dates_in_text"]][:10],
                "payee": _clip(r["payee_hint"], 200), "sent_at": r["ts"], "sender": _clip(r["sender_name"], 120),
                "sender_role": _clip(r["sender_role"], 40), "message_text": _clip(r["text"], 600),
                "group_title": _clip(r["title"], 300), "client_hint": _clip(r["client_name_in_title"], 200),
                "drive_file_id": _clip(r["drive_file_id"], 200),
            })
        return out


def thumbnail(service, file_id: str) -> tuple[bytes, str] | None:
    """A ~640 px picture of the screenshot: Drive's own thumbnail, read-only."""
    meta = service.files().get(fileId=file_id, fields="id,mimeType,thumbnailLink,size", supportsAllDrives=True).execute()
    link = meta.get("thumbnailLink")
    if link:
        resp, content = service._http.request(re.sub(r"=s\d+$", "=s640", link))
        if int(resp.status) == 200 and content and len(content) <= 600_000:
            mime = "image/png" if content[:4] == b"\x89PNG" else "image/webp" if content[8:12] == b"WEBP" else "image/jpeg"
            return content, mime
    if str(meta.get("mimeType", "")).startswith("image/") and int(meta.get("size") or 0) <= 600_000:
        content = service.files().get_media(fileId=file_id, supportsAllDrives=True).execute()
        if content[:3] == b"\xff\xd8\xff":
            return content, "image/jpeg"
        if content[:4] == b"\x89PNG":
            return content, "image/png"
    return None


def run(index, conn, org, tenant_tx, *, service=None, limit_images=1000, refresh_images=False) -> dict:
    rows = rows_from_index(index)
    with tenant_tx(conn, org):
        for r in rows:
            conn.execute(UPSERT, {**r, "org": org})
        want = conn.execute(
            "select sha256,drive_file_id from pulse.fin_wa_screen where drive_file_id is not null and amount is not null"
            + ("" if refresh_images else " and thumb is null") + " order by sent_at desc nulls last limit %s",
            (limit_images,),
        ).fetchall() if service is not None else []
    images = failed = 0
    for w in want:
        try:
            got = thumbnail(service, w["drive_file_id"])
        except Exception:  # noqa: BLE001 - one unreadable file never stops the copy
            got = None
        if not got:
            failed += 1
            continue
        with tenant_tx(conn, org):
            conn.execute("update pulse.fin_wa_screen set thumb=%s,thumb_mime=%s where sha256=%s", (got[0], got[1], w["sha256"]))
        images += 1
    return {"screens": len(rows), "withAmount": sum(1 for r in rows if r["amount"] is not None), "images": images, "imagesMissing": failed}
