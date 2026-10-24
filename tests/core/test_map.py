"""Map ingestion, tenant isolation and pin auditing on synthetic tenants only."""
import csv
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
from pulse_sdk.db import set_tenant
from pulse_workers.geo_seed import load


def seed_files(directory, folder):
    files = {
        "projects_geo.csv": (
            ["project_id", "name", "client", "locality", "city", "lat", "lng", "precision", "source", "rera_numbers", "maps_link"],
            [["development-1", "Test development", "Test client", "Moshi", "Pune", "18.67", "73.85", "locality", "nominatim:test", "", ""]],
        ),
        "localities.csv": (
            ["locality", "city", "lat", "lng", "precision", "source", "project_count", "engagement_count", "aliases"],
            [["Moshi", "Pune", "18.67", "73.85", "locality", "nominatim:test", "1", "1", ""]],
        ),
        "project_engagements.csv": (
            ["project_id", "folder_name", "month", "folder_id"],
            [["development-1", folder, "2026-01", "test-folder"]],
        ),
    }
    for name, (headers, rows) in files.items():
        with (directory / name).open("w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(headers)
            writer.writerows(rows)


def test_map_http_roles_pin_history_and_seed_preservation(worker, owner, api, tmp_path):
    w = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.account set purpose='Workspace account' where handle=%s", (w.editor_handle,))
        for email, pid, role in (("admin@estateautopilots.com", w.manager, "admin"),
                                 ("hr@estateautopilots.com", w.lead, "hr")):
            worker.execute("insert into pulse.account(id,org_id,provider,handle,holder_person_id,purpose) "
                           "values (%s,%s,'google',%s,%s,'Workspace account')", (uuid.uuid4(), w.org, email, pid))
            worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) "
                           "values (%s,%s,%s,'2026-01-01')", (w.org, pid, role))
        folder = worker.execute("select name from pulse.project where id=%s", (w.project,)).fetchone()["name"]
        seed_files(tmp_path, folder)
        first = load(worker, w.org, tmp_path)
        assert first["locations"] == first["folders_linked"] == 1
        location = worker.execute("select id from pulse.project_location").fetchone()["id"]
    other = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, other.org)
        other_location = worker.execute(
            "insert into pulse.project_location(org_id,geo_key,name) values (%s,'foreign','Foreign tenant') returning id",
            (other.org,)).fetchone()["id"]
    root = Path(__file__).resolve().parents[2]
    script = r'''
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from './dist/app.js';
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app=createApp(pool,pool);
const admin='admin@estateautopilots.com', member=process.env.TEST_MEMBER, id=process.env.TEST_LOCATION;
const call=async(url,email,payload)=>{const r=await app.inject({url,method:payload?'POST':'GET',headers:email?{'cf-access-authenticated-user-email':email}:{},...(payload?{payload}:{})}); return {status:r.statusCode,body:r.json()};};
assert.equal((await call('/api/v0/map',null)).status,401);
assert.equal((await call('/api/v0/map','hr@estateautopilots.com')).status,403);
const basic=await call('/api/v0/map',member); assert.equal(basic.status,200); assert.equal(basic.body.locations.length,1); assert.equal(basic.body.canEdit,false); assert.equal('money' in basic.body,false);
const detail=await call(`/api/v0/map/locations/${id}`,member); assert.equal(detail.status,200); assert.equal('money' in detail.body,false);
assert.equal((await call(`/api/v0/map/locations/${id}/pin`,member,{lat:18,lng:73})).status,403);
assert.equal((await call(`/api/v0/map/locations/${process.env.TEST_FOREIGN}`,admin)).status,404);
assert.equal((await call(`/api/v0/map/locations/${process.env.TEST_FOREIGN}/pin`,admin,{lat:18,lng:73})).status,404);
assert.equal((await call('/api/v0/map/locations/not-a-uuid',admin)).status,404);
for(const value of [{lat:91,lng:73},{lat:18,lng:181},{lat:'',lng:73},{lat:true,lng:73},{lat:null,lng:73},{}]) assert.equal((await call(`/api/v0/map/locations/${id}/pin`,admin,value)).status,400);
assert.equal((await call(`/api/v0/map/locations/${id}/pin`,admin,{lat:18.67123456789,lng:73.85123456789,note:'Verified site entrance'})).status,200);
const pinned=await call(`/api/v0/map/locations/${id}`,admin); assert.equal(pinned.body.lat,18.6712346); assert.equal(pinned.body.precision,'exact'); assert.equal(pinned.body.history.length,1); assert.equal(pinned.body.history[0].oldPrecision,'locality'); assert.equal(pinned.body.history[0].note,'Verified site entrance'); assert.ok(pinned.body.history[0].by); assert.equal(pinned.body.money.connected,false);
console.log('RESULT:'+JSON.stringify(pinned.body)); await app.close(); await pool.end();
'''
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "TEST_API_CONFIG": json.dumps(config), "PULSE_ORG_ID": str(w.org),
           "TEST_MEMBER": w.editor_handle, "TEST_LOCATION": str(location), "TEST_FOREIGN": str(other_location)}
    subprocess.run(["node", "--input-type=module", "-e", script], cwd=root / "services/api", env=env,
                   capture_output=True, text=True, check=True, timeout=30)
    # Re-import refreshes the seed, never a pin placed by the owner.
    with worker.transaction():
        set_tenant(worker, w.org)
        load(worker, w.org, tmp_path)
        pinned = worker.execute("select lat,seed_lat,pinned_by from pulse.project_location").fetchone()
        assert pinned["lat"] == 18.6712346 and pinned["seed_lat"] == 18.67
        assert pinned["pinned_by"] == w.manager
        assert worker.execute("select count(*) n from pulse.geo_import where file_name='projects_geo.csv'").fetchone()["n"] == 1
    reset_script = r'''
import assert from 'node:assert/strict'; import { Pool } from 'pg'; import { createApp } from './dist/app.js';
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)),app=createApp(pool,pool),url=`/api/v0/map/locations/${process.env.TEST_LOCATION}/reset`,headers={'cf-access-authenticated-user-email':'admin@estateautopilots.com'};
assert.equal((await app.inject({url,method:'POST',headers,payload:{}})).statusCode,200);
assert.equal((await app.inject({url,method:'POST',headers,payload:{}})).statusCode,409);
await app.close();await pool.end();
'''
    subprocess.run(["node", "--input-type=module", "-e", reset_script], cwd=root / "services/api", env=env,
                   capture_output=True, text=True, check=True, timeout=30)
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        assert api.execute("select precision,pinned_at from pulse.project_location").fetchone() == {"precision": "locality", "pinned_at": None}
        assert api.execute("select count(*) n from pulse.project_location_change").fetchone()["n"] == 2
    # An editor cannot bypass HTTP permissions by writing the table directly.
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("insert into pulse.project_location_change(org_id,location_id,action,changed_by) "
                    "values (%s,%s,'pin',%s)", (w.org, location, w.editor))
    with api.transaction():
        set_tenant(api, other.org)
        assert api.execute("select count(*) n from pulse.project_location_change").fetchone()["n"] == 0
        assert api.execute("select count(*) n from pulse.project_location").fetchone()["n"] == 1
