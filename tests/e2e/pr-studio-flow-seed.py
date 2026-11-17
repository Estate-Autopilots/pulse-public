#!/usr/bin/env python3
"""PR-STUDIO-2 walk seed: prints SQL for a scratch database that already has tests/e2e/pr-pipeline-seed.sql (the synthetic
company "Example Studio (synthetic)" and its admin Asha Example). Adds a personal brand that is on and a company brand that
is a draft, a strategy, synthetic gradient images and a one-page PDF, creatives and posts around today. Obviously fake
values only; never run against a real database."""
import base64
import hashlib
import json
import struct
import zlib

ORG = "00000000-0000-4000-8000-00000000e001"
ASHA = "00000000-0000-4000-8000-00000000a001"
BRAND = "00000000-0000-4000-8000-00000000b501"
DRAFT = "00000000-0000-4000-8000-00000000b502"


def png(w, h, hue):
    """A synthetic gradient with stripes (no text, no real content)."""
    rows = []
    for y in range(h):
        row = bytearray([0])
        for x in range(w):
            t = (x + y) / (w + h)
            r = int(30 + 90 * t + hue[0] * (1 - t))
            g = int(20 + 40 * t + hue[1] * (1 - t))
            b = int(80 + 120 * t + hue[2] * (1 - t))
            if (y // 24) % 7 == 0 and 40 < x < w - 40:
                r, g, b = 235, 230, 255
            row += bytes((min(r, 255), min(g, 255), min(b, 255)))
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")


PDF = (b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj "
       b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 375]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n")


def lit(s):
    return "'" + str(s).replace("'", "''") + "'"


def main():
    out = ["\\set ON_ERROR_STOP on", "begin;", f"select set_config('pulse.org_id', {lit(ORG)}, true);",
           f"""insert into pulse.pr_brand (id, org_id, kind, name, byline, owner_person_id, created_by) values
  ({lit(BRAND)}, {lit(ORG)}, 'personal', 'Asha Example (synthetic)', 'Founder, example only', {lit(ASHA)}, {lit(ASHA)}),
  ({lit(DRAFT)}, {lit(ORG)}, 'company', 'Example Studio brand (synthetic)', '', null, {lit(ASHA)}) on conflict do nothing;"""]
    strategy = {
        "positioning": "Example positioning: one founder shows the work behind an example product, with real-looking but synthetic numbers.",
        "audiences": [{"name": "Example founders", "need": "See how the work is done"}, {"name": "Example engineers", "need": "Proof, not claims"}],
        "pillars": [{"key": "build-log", "name": "Build log", "about": "What shipped this week, with receipts", "share": 40},
                    {"key": "lessons", "name": "Lessons", "about": "One principle from the work", "share": 25},
                    {"key": "case-studies", "name": "Case studies", "about": "Example outcomes, named only with an OK", "share": 20},
                    {"key": "behind", "name": "Behind the scenes", "about": "How the example team works", "share": 15}],
        "channels": [{"key": "linkedin", "perWeek": 2, "days": [2, 4], "times": ["08:30", "12:30"], "note": ""},
                     {"key": "x", "perWeek": 1, "days": [5], "times": ["09:00"], "note": ""},
                     {"key": "whatsapp_status", "perWeek": 1, "days": [4], "times": ["20:30"], "note": ""}],
        "kpis": [{"label": "Posts a week", "metric": "posts_per_week", "target": 4}, {"label": "Impressions a post", "metric": "avg_impressions", "target": 2000},
                 {"label": "Comments in 28 days", "metric": "comments", "target": 40}],
        "rules": ["Example rule: never name a partner without their OK in writing", "Answer every comment in the first hour"],
    }
    out.append(f"""insert into pulse.pr_strategy (org_id, brand_id, status, positioning, audiences, pillars, channels, kpis, months, weeks, rules)
select {lit(ORG)}, {lit(BRAND)}, 'on', {lit(strategy['positioning'])}, {lit(json.dumps(strategy['audiences']))}, {lit(json.dumps(strategy['pillars']))},
  {lit(json.dumps(strategy['channels']))}, {lit(json.dumps(strategy['kpis']))},
  (select jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'), 'theme', 'Example theme ' || (i + 1), 'focus', 'Example focus for the month'))
     from generate_series(0, 2) i, lateral (select date_trunc('month', now()) + make_interval(months => i) m) x),
  (select jsonb_agg(jsonb_build_object('start', (date_trunc('week', now())::date + 7 * i)::text, 'theme', 'Example week theme ' || (i + 2), 'note', 'Synthetic note'))
     from generate_series(-1, 4) i),
  {lit(json.dumps(strategy['rules']))} on conflict do nothing;
insert into pulse.pr_strategy (org_id, brand_id, positioning) values ({lit(ORG)}, {lit(DRAFT)}, 'Example company positioning (synthetic)') on conflict do nothing;""")
    hues = [(120, 40, 200), (40, 60, 220), (20, 140, 200), (30, 160, 120), (200, 120, 30), (160, 40, 160)]
    files = {}

    def add_file(key, data, mime, brand=BRAND):
        fid = f"00000000-0000-4000-8000-{len(files) + 1:012x}"
        files[key] = fid
        out.append(f"""insert into pulse.pr_file (id, org_id, brand_id, name, mime, bytes, sha256, added_by) values ({lit(fid)}, {lit(ORG)}, {lit(brand)}, {lit(key)},
  {lit(mime)}, decode({lit(base64.b64encode(data).decode())}, 'base64'), {lit(hashlib.sha256(data).hexdigest())}, {lit(ASHA)}) on conflict do nothing;""")
        return fid
    assets = [
        ("exmp-c1", "Example carousel: 1,234 synthetic commits", "Example carousels", "carousel", 4, "needs_ok", "Example Partner", "linkedin", "build-log"),
        ("exmp-s1", "Example stat: 99 example releases", "Example single posts", "single", 1, "ready", "", "linkedin", "build-log"),
        ("exmp-s2", "Example quote: gates make you safe", "Example single posts", "single", 1, "check", "Example Colleague", "linkedin", "lessons"),
        ("exmp-x1", "Example thread header", "Example thread headers", "header", 1, "ready", "", "x", "behind"),
        ("exmp-st1", "Example status: 42 example groups", "Example status images", "story", 1, "ready", "", "whatsapp_status", "case-studies"),
        ("exmp-s3", "Example before and after", "Example single posts", "single", 1, "ready", "", "linkedin", "case-studies"),
    ]
    aid = {}
    for n, (key, title, coll, kind, slides, ok, who, ch, pillar) in enumerate(assets):
        sl = []
        for i in range(slides):
            f = add_file(f"{key}-{i + 1}.png", png(216, 270, hues[(n + i) % len(hues)]), "image/png")
            sl.append({"file": f, "thumb": f, "name": f"{key}-{i + 1:02d}", "alt": f"Synthetic slide {i + 1}: an example gradient with stripes."})
        pdf = add_file(f"{key}.pdf", PDF + key.encode(), "application/pdf") if kind == "carousel" else None
        aid[key] = f"00000000-0000-4000-8000-0000000c{n + 1:04x}"
        caption = f"{title}.\n\nThis is an example caption for a synthetic creative. Nothing here is real.\n\n#ExampleTag #Synthetic"
        out.append(f"""insert into pulse.pr_asset (id, org_id, brand_id, source_key, title, collection, kind, size, pillar, channel, format, caption, hashtags, why, hooks, brief, slides,
  pdf_file_id, ok_state, ok_who, ok_note, created_by) values ({lit(aid[key])}, {lit(ORG)}, {lit(BRAND)}, {lit(key)}, {lit(title)}, {lit(coll)}, {lit(kind)}, '1080 × 1350', {lit(pillar)},
  {lit(ch)}, {lit(kind.capitalize())}, {lit(caption)}, array['#ExampleTag','#Synthetic'], 'Example reason: one number per slide is the focal point (synthetic).',
  '{{"A": "Example hook A", "B": "Example hook B", "why": "Test A first (synthetic)."}}', '{{"audience": "Example founders", "goal": "Example aim", "kpi": "Example saves"}}',
  {lit(json.dumps(sl))}, {lit(pdf) if pdf else 'null'}, {lit(ok)}, {lit(who)}, {lit('Example note: confirm before naming them (synthetic).' if ok != 'ready' else '')}, {lit(ASHA)})
  on conflict do nothing;""")
    f = add_file("exmp-d1-1.png", png(216, 270, hues[2]), "image/png", DRAFT)
    out.append(f"""insert into pulse.pr_asset (org_id, brand_id, source_key, title, collection, kind, caption, slides, created_by) values ({lit(ORG)}, {lit(DRAFT)}, 'exmp-d1',
  'Example company sample', 'Example samples', 'single', 'Example company caption #Synthetic', {lit(json.dumps([{"file": f, "thumb": f, "name": "exmp-d1-01", "alt": "Synthetic"}]))}, {lit(ASHA)}) on conflict do nothing;""")
    # Posts around today (the brand's time zone): day offset, time, stage, channel, asset, title.
    posts = [
        (0, "08:30", "scheduled", "linkedin", "exmp-s1", "Example post ready for the 1440 walk"),
        (0, "12:30", "scheduled", "linkedin", "exmp-s3", "Example post ready for the 390 walk"),
        (0, "20:30", "scheduled", "whatsapp_status", "exmp-st1", "Example status for tonight"),
        (2, "08:30", "review", "linkedin", "exmp-c1", "Example carousel waiting for an OK"),
        (3, "09:00", "approved", "x", "exmp-x1", "Example thread header"),
        (5, "12:30", "design", "linkedin", "exmp-s2", "Example quote in design"),
        (-5, "08:30", "scheduled", "linkedin", "exmp-s2", "Example earlier post"),
        (-7, "09:00", "scheduled", "x", "exmp-x1", "Example earlier thread"),
        (None, None, "idea", "linkedin", None, "Example idea: a lesson from the week"),
        (None, None, "draft", "x", None, "Example draft: what one operator runs"),
    ]
    for n, (off, time, stage, ch, a, title) in enumerate(posts):
        pid = f"00000000-0000-4000-8000-0000000d{n + 1:04x}"
        slot = "null" if off is None else f"(((now() at time zone 'Asia/Kolkata')::date + {off}) + time {lit(time)}) at time zone 'Asia/Kolkata'"
        out.append(f"""insert into pulse.pr_post (id, org_id, brand_id, asset_id, title, stage, channel, pillar, format, slot_at, caption, created_by) values ({lit(pid)}, {lit(ORG)}, {lit(BRAND)},
  {lit(aid[a]) if a else 'null'}, {lit(title)}, {lit(stage)}, {lit(ch)}, {lit('build-log' if n % 2 else 'lessons')}, 'Single', {slot}, '', {lit(ASHA)}) on conflict do nothing;""")
    # Two earlier posts were posted and measured (the owner path: as the table owner, through the same columns the move sets).
    out.append("""update pulse.pr_post set stage = 'posted', posted_url = 'https://example.invalid/post/1', posted_by = '00000000-0000-4000-8000-00000000a001'
 where id in ('00000000-0000-4000-8000-0000000d0007', '00000000-0000-4000-8000-0000000d0008');
update pulse.pr_post set stage = 'measured', metrics = '{"impressions": 2400, "reactions": 61, "comments": 12, "shares": 4, "saves": 19}', measured_at = now()
 where id = '00000000-0000-4000-8000-0000000d0007';""")
    out.append("commit;")
    print("\n".join(out))


if __name__ == "__main__":
    main()
