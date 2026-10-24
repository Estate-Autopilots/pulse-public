"""Acceptance for tenant-scoped Meta daily metrics and CID-to-asset projection."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import httpx
from helpers import build_world, emit, issue_asset, upload
from pulse_meta_ads import MetaAdsCollector
from pulse_sdk.collector import TenantContext
from pulse_sdk.db import set_tenant
from pulse_sdk.runtime import CollectorRuntime
from pulse_workers.projector import ProjectionRunner, fingerprint
from pulse_workers.workgraph import WorkGraph


def test_meta_metrics_project_to_project_and_cid_with_missing_conversion_evidence(worker, owner, api):
    w = build_world(worker, owner, api)
    cid = w.cid("HK", 3)
    issue_asset(api, w, cid)
    upload(worker, w, "meta-synthetic-file", f"{cid}-v2.mp4", "synthetic-bytes", folder=w.drafts, minutes=10)
    runner = ProjectionRunner(worker, WorkGraph())
    runner.catch_up(w.org)

    emit(worker, w.org, "ads.metrics.daily", "ad:meta:91001", {
        "ad_account": "123456", "platform_campaign_id": "81001",
        "campaign_name": f"{w.code}{w.registry_no:04d} Pilot campaign", "platform_ad_set_id": "82001",
        "ad_set_name": "Synthetic audience", "platform_ad_id": "91001",
        "ad_name": f"{cid}-v2 · Reels", "day": "2026-10-02", "placement": "facebook:reels",
        "spend": 100.0, "currency": "INR", "impressions": 1000, "reach": 900, "link_clicks": 20,
        "link_ctr": 2.0, "leads": 4, "leads_reported": True, "attribution_setting": "7d_click,1d_view",
        "cid": cid, "cid_version": 2,
    }, source="/collectors/meta_ads/1/synthetic", time=w.at(20))
    emit(worker, w.org, "ads.metrics.daily", "ad:meta:91002", {
        "ad_account": "123456", "platform_campaign_id": "81001",
        "campaign_name": f"{w.code}{w.registry_no:04d} Pilot campaign", "platform_ad_set_id": "82001",
        "ad_set_name": "Synthetic audience", "platform_ad_id": "91002", "ad_name": "Unresolved creative",
        "day": "2026-10-02", "placement": "instagram:story", "spend": 50.0, "currency": "INR",
        "impressions": 500, "leads_reported": False, "attribution_setting": "7d_click,1d_view",
    }, source="/collectors/meta_ads/1/synthetic", time=w.at(21))
    runner.catch_up(w.org)

    with worker.transaction():
        set_tenant(worker, w.org)
        campaign = worker.execute("select project_id, name from pulse.campaign where platform_id = '81001'").fetchone()
        creative = worker.execute("""select a.id as ad_id, a.cid, a.version_id, v.version_no, v.asset_id
                                      from pulse.ad a left join pulse.version v on v.id = a.version_id
                                     where a.platform_id = '91001'""").fetchone()
        metrics = worker.execute("""select spend, leads, leads_reported, link_ctr
                                      from pulse.ad_metric_day m join pulse.ad a on a.id = m.ad_id
                                     where a.platform_id = '91001'""").fetchone()
        missing = worker.execute("""select leads, leads_reported from pulse.ad_metric_day m
                                    join pulse.ad a on a.id = m.ad_id where a.platform_id = '91002'""").fetchone()
        asset = worker.execute("select id from pulse.asset where cid = %s", (cid,)).fetchone()

    assert campaign["project_id"] == w.project
    assert campaign["name"] == f"{w.code}{w.registry_no:04d} Pilot campaign"
    assert creative["cid"] == cid and creative["version_id"] is not None
    assert creative["version_no"] == 2 and creative["asset_id"] == asset["id"]
    assert metrics == {"spend": 100, "leads": 4, "leads_reported": True, "link_ctr": 2.0}
    assert missing == {"leads": None, "leads_reported": False}

    # Projection rebuild deletes and recreates ads while a client lead references one.
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("""insert into pulse.lead (org_id, buyer_id, project_id, ad_id, cid, created_at, status)
                         values (%s, %s, %s, %s, %s, %s, 'new')""",
                      (w.org, uuid.uuid4(), w.project, creative["ad_id"], cid, w.at(22)))
    before = fingerprint(worker, w.org, runner.p.tables)
    runner.rebuild(w.org)
    assert fingerprint(worker, w.org, runner.p.tables) == before
    assert read_lead_ad(worker, w.org, creative["ad_id"])


def read_lead_ad(conn, org, ad_id):
    with conn.transaction():
        set_tenant(conn, org)
        return conn.execute("select exists(select 1 from pulse.lead where ad_id = %s)", (ad_id,)).fetchone()["exists"]


def test_runtime_updates_meta_metrics_for_changed_row_and_dedupes_identical_pull(worker, owner, api):
    w = build_world(worker, owner, api)
    now = datetime.now(UTC).replace(hour=12, minute=0, second=0, microsecond=0)
    spends = ("100.00", "125.00", "125.00")
    requests = []

    def handler(request):
        requests.append(request)
        row = {
            "account_currency": "INR", "campaign_id": "81011",
            "campaign_name": f"{w.code}{w.registry_no:04d} Synthetic campaign", "adset_id": "82011",
            "adset_name": "Synthetic audience", "ad_id": "91011", "ad_name": "Unresolved creative",
            "date_start": now.date().isoformat(), "impressions": "1000", "reach": "900",
            "spend": spends[min(len(requests) - 1, 2)], "inline_link_clicks": "20",
            "inline_link_click_ctr": "2.00", "actions": [{"action_type": "lead", "value": "1"}],
            "publisher_platform": "facebook", "platform_position": "reels",
        }
        return httpx.Response(200, json={"data": [row]})

    ctx = TenantContext(w.org, w.instance,
                        {"meta_ads": {"ad_accounts": ["act_123456"], "lookback_days": 0}},
                        secret=lambda _name: "synthetic-token")
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        collector = MetaAdsCollector(client=client, now=lambda: now)
        runtime = CollectorRuntime(worker, collector)
        runner = ProjectionRunner(worker, WorkGraph())
        first = runtime.poll(ctx)
        runner.catch_up(w.org)
        second = runtime.poll(ctx)
        runner.catch_up(w.org)
        third = runtime.poll(ctx)
        runner.catch_up(w.org)

    assert (first.raw_stored, second.raw_stored, third.raw_stored) == (1, 1, 0)
    with worker.transaction():
        set_tenant(worker, w.org)
        metric = worker.execute("""select m.spend from pulse.ad_metric_day m join pulse.ad a on a.id = m.ad_id
                                   where a.platform_id = '91011'""").fetchone()
        raw_count = worker.execute("select count(*) as count from pulse.raw_inbox where source = %s",
                                   (collector.manifest.source(w.instance),)).fetchone()["count"]
    assert metric["spend"] == 125
    assert raw_count == 2
