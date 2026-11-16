from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from pathlib import Path

import httpx

from pulse_meta_ads import Alert, MetaAdsCollector
from pulse_sdk.collector import RawRecord, TenantContext
from pulse_sdk.envelope import make_event
from pulse_sdk.ulid import new_ulid
from pulse_sdk.validate import EventValidator

FIXTURE = Path(__file__).parent / "fixtures" / "insights.json"
ROWS = json.loads(FIXTURE.read_text(encoding="utf-8"))
NOW = datetime(2026, 10, 5, 12, tzinfo=UTC)


def context(**config) -> TenantContext:
    return TenantContext(uuid.UUID("39f1db08-1d2f-49c0-9a39-f5f0fb25defa"), "synthetic-meta",
                         {"meta_ads": {"ad_accounts": ["act_123456"], **config}},
                         secret=lambda name: "synthetic-token" if name == "META_ADS_SYSTEM_USER_TOKEN" else "")


def record(row: dict) -> RawRecord:
    placement = f"{row['publisher_platform']}:{row['platform_position']}"
    return RawRecord(f"123456:{row['ad_id']}:{row['date_start']}:{placement}",
                     {"account_id": "123456", "row": row, "placement": placement,
                      "attribution_setting": "7d_click,1d_view"})


def test_synthetic_campaign_fixtures_normalise_to_valid_daily_events():
    collector = MetaAdsCollector(now=lambda: NOW)
    events = [collector.normalise(context(), record(row))[0] for row in ROWS]

    assert [event["data"]["campaign_name"] for event in events] == [
        "EA0584 Kevaleto Rogotipil", "EA0585 Project Oak", "EA0586 Project Pine"]
    first = events[0]["data"]
    assert (first["spend"], first["leads"], first["link_clicks"], first["link_ctr"]) == (1600, 8, 20, 1.25)
    assert (first["cid"], first["cid_version"], first.get("cid_variant")) == ("EA0584-HK03", 2, None)
    assert events[1]["data"]["leads_reported"] is False and "leads" not in events[1]["data"]
    assert "cid" not in events[2]["data"]

    for event in events:
        event_time = datetime.fromisoformat(event["time"].replace("Z", "+00:00"))
        full = make_event(org_id=context().org_id, id=new_ulid(event_time),
                          source=collector.manifest.source("synthetic-meta"), type=event["type"],
                          time=event_time, subject=event["subject"],
                          purpose=event["purpose"], sensitivity=event["sensitivity"],
                          visibility=event["visibility"], data=event["data"], collectorver=collector.manifest.version)
        assert EventValidator().errors(full, now=NOW) == []


def test_poll_uses_read_only_v26_insights_and_resumes_after_cursor():
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.url.path == "/v26.0/act_123456/insights"
        assert "access_token" not in request.url.params
        assert request.headers["Authorization"] == "Bearer synthetic-token"
        assert request.url.params["breakdowns"] == "publisher_platform,platform_position"
        assert request.url.params["action_attribution_windows"] == '["7d_click","1d_view"]'
        if request.url.params.get("after") == "page-2":
            return httpx.Response(200, json={"data": [ROWS[1]], "paging": {"cursors": {}}})
        return httpx.Response(200, json={"data": [ROWS[0]], "paging": {
            "cursors": {"after": "page-2"}, "next": "https://graph.facebook.com/next?access_token=secret"}})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    collector = MetaAdsCollector(client=client, now=lambda: NOW)
    first, cursor = collector.poll(context(), None)
    second, next_cursor = collector.poll(context(), cursor)
    assert len(first) == len(second) == 1
    assert cursor["after"] == "page-2" and next_cursor["after"] is None
    assert len(requests) == 2


def test_token_expiry_emits_a_non_secret_alert():
    alerts: list[Alert] = []

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": {"code": 190, "error_subcode": 463,
                                                     "message": "synthetic expired token"}})

    collector = MetaAdsCollector(client=httpx.Client(transport=httpx.MockTransport(handler)), alert_sink=alerts.append,
                                 now=lambda: NOW)
    assert collector.authorize(context()).ok is False
    assert len(alerts) == 1
    assert alerts[0].code == "meta_token_expired"
    assert "synthetic-token" not in alerts[0].detail


def test_api_version_expiry_alert_fires_within_30_days():
    alerts: list[Alert] = []
    collector = MetaAdsCollector(alert_sink=alerts.append, now=lambda: NOW)
    collector._check_version_expiry(context(api_version_expires_on="2026-10-20"))
    assert len(alerts) == 1
    assert alerts[0].code == "api_version_expiring"
    assert "15 days" in alerts[0].detail


def test_manifest_is_read_only_and_uses_ads_read():
    assert MetaAdsCollector.manifest.scopes == ("ads_read",)
    assert MetaAdsCollector.manifest.filters["writes"] is False
    assert MetaAdsCollector.manifest.emits == ("ads.metrics.daily",)
