# ruff: noqa: E501
"""Transparent outcome primitives; no employee attribution or presence-based score."""

import math

CREDITS = {"model_video": 4, "vov": 2, "hook": 1, "image_ad": 0.5, "carousel_card": 0.25}


def visit_estimate(successes, n, prior_rate, prior_weight=40):
    if n < 40:
        return None, None, None, "thin" if n else "none"
    a = successes + prior_rate * prior_weight
    b = n - successes + (1 - prior_rate) * prior_weight
    value = a / (a + b)
    se = math.sqrt(a * b / ((a + b) ** 2 * (a + b + 1)))
    return value, max(0, value - 1.96 * se), min(1, value + 1.96 * se), "enough"


def store_outcomes(c, org, as_of):
    from psycopg.types.json import Jsonb

    counts = c.execute("""select count(*) filter(where t.outcome is not null) n,
      count(*) filter(where t.outcome in ('visit_planned','visit_done','booked')) wins
      from pulse.lead l join pulse.lead_touch t on t.lead_id=l.id where l.kind='buyer'""").fetchone()
    prior = counts["wins"] / max(1, counts["n"])
    # Delete only this importer-owned projection. Human/model scores from other sources remain untouched.
    c.execute("delete from pulse.score where metric='recorded_visit_intent' and model_name='research-beta-binomial'")
    groups = c.execute("""select l.project_id,min(l.created_at)::date first,count(*) filter(where t.outcome is not null) n,
      count(*) filter(where t.outcome in ('visit_planned','visit_done','booked')) wins
      from pulse.lead l join pulse.lead_touch t on t.lead_id=l.id
      where l.kind='buyer' and l.project_id is not null group by l.project_id""").fetchall()
    for g in groups:
        value, low, high, sufficiency = visit_estimate(g["wins"], g["n"], prior)
        explanation = {
            "source": "cleaned_sheet_call_notes",
            "numerator": g["wins"],
            "denominator": g["n"],
            "prior_weight": 40,
            "prior_rate": prior,
            "source_as_of": as_of.isoformat(),
            "scope": "Uniquely matched project only. Ambiguous engagement links are excluded.",
            "interval": "Approximate 95% beta-binomial normal interval",
            "limitations": "Among leads with call notes; observational, not creative/person attribution.",
        }
        c.execute(
            """insert into pulse.score(org_id,subject_type,subject_id,metric,period_start,period_end,value,
          ci_low,ci_high,n_effective,sufficiency,explanation,model_name,model_version,visibility)
          values(%s,'project',%s,'recorded_visit_intent',%s,%s,%s,%s,%s,%s,%s,%s,'research-beta-binomial','1','org')""",
            (
                org,
                g["project_id"],
                g["first"] or as_of,
                as_of,
                value,
                low,
                high,
                g["n"],
                sufficiency,
                Jsonb(explanation),
            ),
        )
    return len(groups)
