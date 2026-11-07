"""HR proposals: Maharashtra's published 2026 list; 2027 fixed dates and company days await approval."""

from psycopg.types.json import Jsonb

PUBLIC_2026 = [
    ("01-26", "Republic Day"),
    ("02-15", "Mahashivratri"),
    ("02-19", "Shivaji Maharaj Jayanti"),
    ("03-03", "Holi"),
    ("03-19", "Gudhi Padwa"),
    ("03-21", "Ramzan Eid"),
    ("03-26", "Ram Navami"),
    ("03-31", "Mahavir Janmakalyanak"),
    ("04-03", "Good Friday"),
    ("04-14", "Ambedkar Jayanti"),
    ("05-01", "Maharashtra Day / Buddha Pournima"),
    ("05-28", "Bakri Eid"),
    ("06-26", "Moharum"),
    ("08-15", "Independence Day / Parsi New Year"),
    ("08-26", "Id-E-Milad"),
    ("09-14", "Gosele Chaturthi"),
    ("10-02", "Gandhi Jayanti"),
    ("10-20", "Dasara"),
    ("11-08", "Diwali Laxmi Pujan"),
    ("11-10", "Diwali Bali Pratipada"),
    ("11-24", "Guru Nanak Jayanti"),
    ("12-25", "Christmas"),
]
SOURCE = "https://maharashtra.gov.in/site/Upload/pdf/Public-Holiday-2026.pdf"


def propose(c, org):
    proposals = [("2026-" + d, n, False, SOURCE) for d, n in PUBLIC_2026]
    proposals += [("2026-11-11", "Bhau Beej (proposed company day)", True, SOURCE)]
    proposals += [
        (
            "2027-" + d,
            n,
            False,
            "Fixed calendar date; official 2027 notification and company policy need HR confirmation",
        )
        for d, n in [
            ("01-26", "Republic Day"),
            ("02-19", "Shivaji Maharaj Jayanti"),
            ("04-14", "Ambedkar Jayanti"),
            ("05-01", "Maharashtra Day"),
            ("08-15", "Independence Day"),
            ("10-02", "Gandhi Jayanti"),
            ("12-25", "Christmas"),
        ]
    ]
    proposals += [("2027-01-01", "New Year (proposed company day)", True, "Company choice; HR confirmation required")]
    for day, name, optional, source in proposals:
        c.execute(
            """insert into pulse.review_item(org_id,source_key,kind,title,proposed,confidence,evidence)
         values(%s,%s,'holiday',%s,%s,%s,%s) on conflict do nothing""",
            (
                org,
                "holiday:" + day,
                day + " · " + name,
                Jsonb({"day": day, "name": name, "optional": optional}),
                0.98 if day.startswith("2026") else 0.65,
                Jsonb({"source": source, "note": "Proposed only; no attendance/leave impact until HR accepts."}),
            ),
        )
    return len(proposals)
