"""Meta Marketing API v26 read-only pull collector (03 S14, 05 §5)."""

from __future__ import annotations

import hashlib
import json
import logging
import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import httpx

from pulse_sdk import cid as cidlib
from pulse_sdk.collector import AuthStatus, Cursor, Health, Manifest, RawRecord, Scope, TenantContext

log = logging.getLogger("pulse.collector.meta_ads")
API_VERSION = "v26.0"
TOKEN_NAME = "META_ADS_SYSTEM_USER_TOKEN"
ATTRIBUTION_SETTING = "7d_click,1d_view"
API_ROOT = "https://graph.facebook.com"
INSIGHT_FIELDS = ",".join((
    "account_currency", "campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name",
    "date_start", "date_stop", "impressions", "reach", "spend", "inline_link_clicks", "inline_link_click_ctr",
    "actions",
))
ACCOUNT_ID = re.compile(r"^(?:act_)?([0-9]{1,32})$")


@dataclass(frozen=True)
class Alert:
    code: str
    detail: str
    dedupe_key: str


class MetaAdsApiError(RuntimeError):
    def __init__(self, code: int | None, subcode: int | None):
        self.code = code
        self.subcode = subcode
        super().__init__(f"Meta Marketing API request failed (code={code}, subcode={subcode})")


class MetaAdsTokenExpired(MetaAdsApiError):
    pass


def _decimal(value: Any, field: str) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"invalid numeric metric {field}") from exc
    if not number.is_finite() or number < 0:
        raise ValueError(f"invalid numeric metric {field}")
    return number


def _action_count(actions: Any, action_type: str) -> int | None:
    if not isinstance(actions, list):
        return None
    values = [_decimal(item.get("value"), action_type) for item in actions
              if isinstance(item, dict) and item.get("action_type") == action_type]
    found = [value for value in values if value is not None]
    return int(sum(found, Decimal(0))) if found else None


def _cid_from_name(name: str) -> tuple[str | None, int | None, str | None]:
    parsed = cidlib.parse_prefix(name)
    if parsed is None:
        return None, None, None
    return parsed.base, parsed.version, parsed.variant


def _metrics_digest(row: dict[str, Any]) -> str:
    """Version an insights row when metrics or projected labels change; keep identical pulls idempotent."""
    fields = ("account_currency", "campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name",
              "date_start", "publisher_platform", "platform_position", "impressions", "reach", "spend",
              "inline_link_clicks", "inline_link_click_ctr", "actions")
    stable = {field: row.get(field) for field in fields}
    actions = stable["actions"]
    if isinstance(actions, list):
        stable["actions"] = sorted(
            actions, key=lambda action: json.dumps(action, sort_keys=True, separators=(",", ":")))
    encoded = json.dumps(stable, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:16]


def _metric_count(row: dict[str, Any], key: str) -> int | None:
    value = _decimal(row.get(key), key)
    return int(value) if value is not None else None


class MetaAdsCollector:
    """Collect daily ad-level metrics; provide a callback for durable alert routing."""

    manifest = Manifest.from_yaml(Path(__file__).parents[2] / "manifest.yaml")

    def __init__(self, *, client: httpx.Client | None = None,
                 alert_sink: Callable[[Alert], None] | None = None,
                 api_version: str = API_VERSION,
                 now: Callable[[], datetime] | None = None):
        if not re.fullmatch(r"v[0-9]+\.0", api_version):
            raise ValueError("api_version must be a pinned Marketing API version such as v26.0")
        self.api_version = api_version
        self.client = client or httpx.Client(timeout=20.0)
        self.alert_sink = alert_sink
        self.now = now or (lambda: datetime.now(UTC))
        self._alert_keys: set[str] = set()

    def _alert(self, alert: Alert) -> None:
        if alert.dedupe_key in self._alert_keys:
            return
        self._alert_keys.add(alert.dedupe_key)
        log.warning("collector alert code=%s detail=%s", alert.code, alert.detail)
        if self.alert_sink:
            self.alert_sink(alert)

    def _check_version_expiry(self, ctx: TenantContext) -> None:
        cfg = (ctx.config.get("meta_ads") or {}) if isinstance(ctx.config, dict) else {}
        raw_expiry = cfg.get("api_version_expires_on")
        if not raw_expiry:
            return
        try:
            expiry = date.fromisoformat(str(raw_expiry))
        except ValueError:
            self._alert(Alert("api_version_expiry_config_invalid", "Meta API expiry date is not an ISO date.",
                              f"{self.api_version}:invalid-expiry"))
            return
        days_left = (expiry - self.now().date()).days
        if days_left <= 30:
            timing = "has expired" if days_left < 0 else f"expires in {days_left} days"
            detail = f"Meta Marketing API {self.api_version} {timing}; upgrade the pin."
            self._alert(Alert("api_version_expiring", detail, f"{self.api_version}:{expiry.isoformat()}"))

    @staticmethod
    def _accounts(ctx: TenantContext) -> list[str]:
        cfg = (ctx.config.get("meta_ads") or {}) if isinstance(ctx.config, dict) else {}
        values = cfg.get("ad_accounts", [])
        if not isinstance(values, list):
            raise ValueError("meta_ads.ad_accounts must be a list")
        result = []
        for value in values:
            match = ACCOUNT_ID.fullmatch(str(value))
            if not match:
                raise ValueError("Meta ad account ids must contain digits, optionally prefixed by act_")
            result.append(match.group(1))
        return result

    @staticmethod
    def _token(ctx: TenantContext) -> str:
        if ctx.secret is None:
            raise RuntimeError(f"secret broker does not provide {TOKEN_NAME}")
        try:
            token = ctx.secret(TOKEN_NAME)
        except Exception:
            raise RuntimeError(f"secret broker could not provide {TOKEN_NAME}") from None
        if not token:
            raise RuntimeError(f"secret {TOKEN_NAME} is not configured")
        return token

    def scope(self, ctx: TenantContext) -> Scope:
        return Scope(tuple(self._accounts(ctx)))

    def _get(self, ctx: TenantContext, token: str, path: str, params: dict[str, Any]) -> dict[str, Any]:
        self._check_version_expiry(ctx)
        response = self.client.get(f"{API_ROOT}/{self.api_version}/{path.lstrip('/')}",
                                   params=params, headers={"Authorization": f"Bearer {token}"})
        try:
            payload = response.json()
        except ValueError as exc:
            raise RuntimeError("Meta Marketing API returned invalid JSON") from exc
        error = payload.get("error") if isinstance(payload, dict) else None
        if not response.is_success or isinstance(error, dict):
            code = error.get("code") if isinstance(error, dict) else None
            subcode = error.get("error_subcode") if isinstance(error, dict) else None
            try:
                code = int(code) if code is not None else None
                subcode = int(subcode) if subcode is not None else None
            except (TypeError, ValueError):
                code, subcode = None, None
            if code == 190:
                detail = "Meta Ads token expired or was revoked; restore the read-only token."
                self._alert(Alert("meta_token_expired", detail, TOKEN_NAME))
                raise MetaAdsTokenExpired(code, subcode)
            raise MetaAdsApiError(code, subcode)
        if not isinstance(payload, dict):
            raise RuntimeError("Meta Marketing API returned a non-object response")
        return payload

    def authorize(self, ctx: TenantContext) -> AuthStatus:
        self._check_version_expiry(ctx)
        try:
            accounts = self._accounts(ctx)
            token = self._token(ctx)
            if not accounts:
                return AuthStatus(False, "No Meta ad accounts are configured.")
            self._get(ctx, token, f"act_{accounts[0]}/insights", {
                "fields": "spend", "level": "account", "date_preset": "last_7d", "limit": 1,
            })
        except MetaAdsApiError as exc:
            return AuthStatus(False, str(exc))
        except RuntimeError as exc:
            return AuthStatus(False, str(exc))
        return AuthStatus(True)

    def health(self, ctx: TenantContext) -> Health:
        auth = self.authorize(ctx)
        return Health(auth.ok, detail=auth.detail)

    def _window(self, ctx: TenantContext) -> tuple[date, date]:
        cfg = (ctx.config.get("meta_ads") or {}) if isinstance(ctx.config, dict) else {}
        days = int(cfg.get("lookback_days", 0))
        if not 0 <= days <= 28:
            raise ValueError("meta_ads.lookback_days must be between 0 and 28")
        today = self.now().date()
        return today - timedelta(days=days), today

    def _page(self, ctx: TenantContext, token: str, account: str, since: date, until: date,
              after: str | None) -> tuple[list[RawRecord], str | None]:
        params: dict[str, Any] = {
            "fields": INSIGHT_FIELDS,
            "level": "ad",
            "time_increment": 1,
            "time_range": json.dumps({"since": since.isoformat(), "until": until.isoformat()}, separators=(",", ":")),
            "breakdowns": "publisher_platform,platform_position",
            "action_attribution_windows": json.dumps(["7d_click", "1d_view"], separators=(",", ":")),
            "limit": 500,
        }
        if after:
            params["after"] = after
        payload = self._get(ctx, token, f"act_{account}/insights", params)
        rows = payload.get("data", [])
        if not isinstance(rows, list):
            raise RuntimeError("Meta Marketing API insights data must be a list")
        records = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            ad_id = str(row.get("ad_id") or "")
            day = str(row.get("date_start") or "")
            if not ad_id or not day:
                raise ValueError("Meta Insights row is missing ad_id or date_start")
            platform = str(row.get("publisher_platform") or "all")
            position = str(row.get("platform_position") or "all")
            placement = "all" if platform == "all" and position == "all" else f"{platform}:{position}"
            records.append(RawRecord(
                source_ref=f"{account}:{ad_id}:{day}:{placement}:{_metrics_digest(row)}",
                payload={"account_id": account, "row": row, "placement": placement,
                         "attribution_setting": ATTRIBUTION_SETTING},
            ))
        after_cursor = ((payload.get("paging") or {}).get("cursors") or {}).get("after")
        has_next = bool((payload.get("paging") or {}).get("next"))
        if has_next and not after_cursor:
            raise RuntimeError("Meta Insights returned a next page without an after cursor")
        return records, str(after_cursor) if has_next else None

    def poll(self, ctx: TenantContext, cursor: Cursor | None) -> tuple[list[RawRecord], Cursor]:
        self._check_version_expiry(ctx)
        accounts = self._accounts(ctx)
        if not accounts:
            return [], cursor or {}
        token = self._token(ctx)
        since, until = self._window(ctx)
        same_window = cursor and cursor.get("since") == since.isoformat() and cursor.get("until") == until.isoformat()
        account_index = int(cursor.get("account_index", 0)) if same_window else 0
        after = cursor.get("after") if same_window else None
        if account_index >= len(accounts):
            account_index, after = 0, None
        records, next_after = self._page(ctx, token, accounts[account_index], since, until, after)
        next_index = account_index if next_after else (account_index + 1) % len(accounts)
        return records, {"since": since.isoformat(), "until": until.isoformat(), "account_index": next_index,
                         "after": next_after if next_after else None}

    def backfill(self, ctx: TenantContext, since: datetime,
                 cursor: Cursor | None) -> Iterator[tuple[list[RawRecord], Cursor]]:
        if cursor and cursor.get("complete"):
            return
        self._check_version_expiry(ctx)
        accounts = self._accounts(ctx)
        if not accounts:
            return
        token = self._token(ctx)
        start = date.fromisoformat(cursor["since"]) if cursor and cursor.get("since") else since.date()
        end = date.fromisoformat(cursor["until"]) if cursor and cursor.get("until") else self.now().date()
        account_index = int(cursor.get("account_index", 0)) if cursor else 0
        after = cursor.get("after") if cursor else None
        while account_index < len(accounts):
            records, next_after = self._page(ctx, token, accounts[account_index], start, end, after)
            if next_after:
                next_cursor: Cursor = {"since": start.isoformat(), "until": end.isoformat(),
                                       "account_index": account_index, "after": next_after}
            elif account_index + 1 < len(accounts):
                account_index += 1
                after = None
                next_cursor = {"since": start.isoformat(), "until": end.isoformat(),
                               "account_index": account_index, "after": None}
            else:
                next_cursor = {"since": start.isoformat(), "until": end.isoformat(), "account_index": 0,
                               "after": None, "complete": True}
            yield records, next_cursor
            if next_cursor.get("complete"):
                return
            account_index = int(next_cursor["account_index"])
            after = next_cursor.get("after")

    def handle_push(self, ctx, req):
        raise NotImplementedError("Meta Marketing API is pull-only")

    def normalise(self, ctx: TenantContext, raw: RawRecord) -> list[dict[str, Any]]:
        payload = raw.payload
        row = payload["row"]
        ad_name = str(row.get("ad_name") or "")
        cid, cid_version, cid_variant = _cid_from_name(ad_name)
        leads = _action_count(row.get("actions"), "lead")
        impressions = _metric_count(row, "impressions") or 0
        clicks = _metric_count(row, "inline_link_clicks")
        ctr = _decimal(row.get("inline_link_click_ctr"), "inline_link_click_ctr")
        if ctr is None and clicks is not None and impressions:
            ctr = Decimal(clicks) * Decimal(100) / Decimal(impressions)
        day = date.fromisoformat(str(row["date_start"]))
        data: dict[str, Any] = {
            "ad_account": payload["account_id"],
            "platform_campaign_id": str(row["campaign_id"]),
            "campaign_name": str(row["campaign_name"]),
            "platform_ad_set_id": str(row["adset_id"]),
            "platform_ad_id": str(row["ad_id"]),
            "ad_name": ad_name,
            "day": day.isoformat(),
            "placement": payload["placement"],
            "spend": float(_decimal(row.get("spend"), "spend") or Decimal(0)),
            "currency": str(row.get("account_currency") or "").upper(),
            "impressions": impressions,
            "leads_reported": leads is not None,
            "attribution_setting": str(payload.get("attribution_setting", ATTRIBUTION_SETTING)),
        }
        optional = {
            "ad_set_name": row.get("adset_name"),
            "reach": _metric_count(row, "reach"),
            "video_3s_plays": _action_count(row.get("actions"), "video_view"),
            "link_clicks": clicks,
            "link_ctr": float(ctr) if ctr is not None else None,
            "leads": leads,
            "cid": cid,
            "cid_version": cid_version,
            "cid_variant": cid_variant,
        }
        data.update({key: value for key, value in optional.items() if value is not None})
        return [{
            "type": "ads.metrics.daily",
            "time": f"{day.isoformat()}T00:00:00Z",
            "subject": f"ad:meta:{row['ad_id']}",
            "purpose": "outcomes",
            "sensitivity": 0,
            "visibility": "org",
            "data": data,
        }]
