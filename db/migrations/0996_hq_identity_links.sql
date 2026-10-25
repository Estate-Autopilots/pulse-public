-- migrate:up
-- EST-2551: internal paths and bounded absolute HTTPS links, matching pulse-hq.ts HREF.
alter table pulse.hq_feature drop constraint hq_feature_href_check;
alter table pulse.hq_feature add constraint hq_feature_href_check check (href is null or (
  length(href) <= 300 and href !~ '[[:space:]]' and href ~ $href$^(/([A-Za-z0-9?=&._-][A-Za-z0-9/?=&._-]*)?|https://[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+(:([0-5]?[0-9]{1,4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?([/?#][^[:space:]\\]*)?)$$href$
));

-- migrate:down
-- Forward-only: retain the wider check so a code rollback preserves saved external links.
