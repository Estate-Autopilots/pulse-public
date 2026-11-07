"""Read-only Meta Ads daily metrics collector (03 S14, 05 §5)."""

from .collector import API_VERSION, Alert, MetaAdsApiError, MetaAdsCollector, MetaAdsTokenExpired

__all__ = ["API_VERSION", "Alert", "MetaAdsApiError", "MetaAdsCollector", "MetaAdsTokenExpired"]
