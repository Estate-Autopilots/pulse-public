# Meta Ads collector (S14)

Read-only pull of daily, ad-level Meta Marketing API insights. It emits `ads.metrics.daily` with spend, impressions,
reach, inline link clicks and CTR, aggregate `lead` actions, video-view counts, attribution setting, and the ad name's
CID. It requests placement breakdowns, uses `7d_click` + `1d_view`, and never requests or stores lead form fields,
buyer contact data, or any write-capable Meta operation.

## Configuration

The runtime supplies tenant config and the secret broker to `TenantContext`:

```python
config = {
    "meta_ads": {
        "ad_accounts": ["act_123456789"],
        "lookback_days": 0,                    # 0 for hourly today; 28 for nightly reconcile
        "api_version_expires_on": "2026-12-01",  # update when Meta publishes the v26 sunset
    }
}
```

The broker supplies only `META_ADS_SYSTEM_USER_TOKEN`, shared with the existing Ads connection. Required scope:
`ads_read`. The collector pins Marketing API `v26.0`; the versioned path is part of every request. Accounts are scoped
by numeric ad account id. No token is accepted from tenant config, environment variables, fixtures, or URLs.

The official Meta version schedule currently lists v26.0 expiry as TBD; when Meta publishes the sunset, configure its
date here. The collector alerts 30 days before that date and after expiry. A Graph API error code 190 emits a
`meta_token_expired` alert. Supply `alert_sink(Alert)` to route the structured alert into the tenant's alert system;
without a sink, the collector writes a redacted warning to its logger.

## Project and creative linking

The project projector matches a campaign name beginning with `<tenant-code><registry-number>` to the tenant's
project registry (for example `EA0584`). An ad name beginning with a valid CID sets `ad.cid` to the base asset CID;
`-vN` and variant suffixes link `ad.version_id` when that version exists. Ads without a valid CID keep their metrics
and use `link_method = unresolved`. Project and leadership totals can be rolled up from `ad_metric_day`; CTR is the
reported inline link CTR, while CPL is `spend / leads` only when conversion evidence is reported for the full slice.

`leads` is the aggregate `actions[action_type=lead]` count. If Meta omits that action, the event omits `leads` and sets
`leads_reported=false`; consumers must expose that gap instead of treating it as a confirmed zero. This is aggregate
campaign evidence only. S15 buyer-level lead retrieval, contact details, and webhooks are outside this ads_read-only
collector.

## Recovery and reconciliation

- Missing or expired key: ask the Pulse CTO to restore the shared `META_ADS_SYSTEM_USER_TOKEN` secret in Infisical;
  the collector reports missing configuration or alerts on Graph API code 190 without including token material.
- Version warning: update the pinned API version after checking Meta's [version schedule](https://developers.facebook.com/docs/graph-api/changelog/versions/), update `api_version_expires_on`, run the fixture suite, then deploy the new collector version.
- API or permission error: check that the shared system user still has `ads_read` and the account remains in the configured scope. Other Graph API errors expose only numeric code/subcode.
- Compare spend, leads, and CPL against Ads Manager for the same three live campaigns, date range, placement rollup, currency, and `7d_click` + `1d_view` attribution. The target is within 2%. A slice with any `leads_reported=false` row has incomplete conversion evidence and must be labeled accordingly.
- `poll` returns one API page per call. The scheduler must persist its cursor and invoke the collector again until `after` is empty; `backfill` already iterates pages. `lookback_days` applies to the supplied tenant context, so hourly-today and 28-day reconcile schedules need their own context/configuration.
- The current day boundary is calculated in UTC, while Meta interprets `time_range` in each ad account's timezone. Configure and verify timezone-aware windows before enabling scheduled staging pulls for non-UTC accounts.
- Reach repeats across placement rows and must not be summed. Spend, leads, impressions, and link clicks are additive across placements; use an `all` placement query or a deduplicated reach source for reach totals.

Tests use synthetic campaigns only:

```bash
uv run --directory collectors/meta_ads pytest -q
```
