"""PULSE-ID: Sign in with Pulse and the data API apps call with its tokens (db/migrations/1115_pulse_identity.sql,
services/api/src/oidc.ts, connect-api.ts; docs/architecture/PULSE_IDENTITY_AND_DATA_API.md).

The API acceptance (services/api/test/oidc-runner.mjs) on the synthetic agency: an install admin registers a fictional
Sales X-Ray; a member signs in with Pulse (authorization code + PKCE, an RS256 ID token checked against the JWKS, the
contract's claims, the signed photo address, userinfo); codes and refresh tokens cannot be replayed; an admin links the
organisation (members with photos, titles and teams, paging, webhooks, work signals, clients, money only once switched
on, leads and calls written in with XRAY-LINK's rules); a member cannot link it; the admin narrows or ends it in Pulse;
the app ends it; sign-up starts a new account and organisation; and every refusal answers as the contract says."""
from __future__ import annotations

import struct
import uuid
import zlib

from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant

from test_sop import demo_world, run_runner


def tiny_png() -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    raw = b"\x00\xff\x99\x33\xff"  # one RGBA pixel
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def test_sign_in_with_pulse(worker, owner, api, tmp_path):
    w, p = demo_world(worker, owner, api)
    client, contact, invoice = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    with owner.transaction():
        role = owner.execute("select pg_get_userbyid(nspowner) as r from pg_namespace where nspname='pulse'").fetchone()["r"]
        owner.execute(f"set local role {role}")
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.person_photo(org_id,person_id,mime,bytes) values(%s,%s,'image/png',%s)", (w.org, p['kabir'], tiny_png()))
        owner.execute("""insert into pulse.client(id,org_id,display_name,company_name,email,phone,city,status,source)
                         values(%s,%s,'Lakeview Interiors (test)','Lakeview Interiors','hello@lakeview.example','+91 90000 00101','Pune','active','manual')""",
                      (client, w.org))
        owner.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Asha Kireteso (test)','client')", (contact, w.org))
        owner.execute("insert into pulse.contact_profile(org_id,person_id,designation,email,phone) values(%s,%s,'Owner','asha@lakeview.example','+91 90000 00102')",
                      (w.org, contact))
        owner.execute("insert into pulse.client_contact(org_id,client_id,person_id,is_primary) values(%s,%s,%s,true)", (w.org, client, contact))
        owner.execute("""insert into pulse.erp_document(id,org_id,doc_type,status,number,fy,issue_date,client_id,seller,buyer,reference,taxable,total)
                         values(%s,%s,'invoice','part_paid','INV-T1','2026-27','2026-10-01',%s,%s,%s,%s,100000,118000)""",
                      (invoice, w.org, client, Jsonb({"name": "Synthetic agency"}), Jsonb({"name": "Lakeview Interiors"}), Jsonb({})))
        owner.execute("insert into pulse.erp_payment(org_id,document_id,received_on,amount) values(%s,%s,'2026-10-10',50000)", (w.org, invoice))
    report = run_runner('oidc-runner', w, p, tmp_path, extra={'TEST_CLIENT': str(client), 'TEST_CONTACT': str(contact)}, timeout=600)
    assert report['checks'] >= 120
