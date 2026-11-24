-- migrate:up
-- PM-BUILD-4 (KAZUK-PM-2 phase 6, leadership; R48): each person's load is read against their OWN benchmark (healthy
-- range and "review above", in the template's units), set only by leadership (Kazuk: "only the CEO"; Vitals OS has no
-- separate CEO flag, so leadership, as every other company-wide setting), each change logged. And one leadership read
-- for the desk: date moves of the last 30 days by reason (the template's words, and whose side: the client's or ours)
-- and what the company waits on its clients for (open waits, 2520), apart from the team's lateness.
-- Additive: one table, two functions.

create table pulse.load_benchmark (
  org_id uuid not null references pulse.org(id),
  person_id uuid not null references pulse.person(id),
  healthy_low numeric(4,1) not null check (healthy_low >= 0),
  healthy_high numeric(4,1) not null check (healthy_high >= healthy_low),
  review_above numeric(4,1) not null check (review_above >= healthy_high),
  note text check (length(note) <= 300),
  set_by uuid not null references pulse.person(id),
  set_at timestamptz not null default now(),
  cleared_at timestamptz,
  primary key (org_id, person_id)
);
alter table pulse.load_benchmark enable row level security;
alter table pulse.load_benchmark force row level security;
create policy tenant on pulse.load_benchmark using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
-- Read by leadership and HR, and by the person themself (never by colleagues).
create policy sees on pulse.load_benchmark as restrictive for select to pulse_api
  using (person_id = pulse.current_viewer() or pulse.viewer_is('admin', 'leadership', 'hr'));
grant select on pulse.load_benchmark to pulse_api;

-- Set (or clear, with nulls) a person's benchmark: only a person in leadership (or an admin), never an AI.
create function pulse.load_benchmark_set(p_person uuid, p_low numeric, p_high numeric, p_review numeric, p_note text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer();
begin
  if not plan_by_person() then raise exception 'Only a person sets a load benchmark' using errcode = '42501'; end if;
  if not viewer_is('admin', 'leadership') then raise exception 'Only leadership sets each person''s load benchmark' using errcode = '42501'; end if;
  if not exists (select 1 from person where org_id = current_org() and id = p_person and side = 'staff' and status = 'active') then
    raise exception 'Choose someone in the team' using errcode = 'P0002'; end if;
  -- All three empty: back to the template's range. The row stays (cleared_at), nothing is deleted.
  if p_low is null and p_high is null and p_review is null then
    update load_benchmark set cleared_at = now(), set_by = me, set_at = now() where org_id = current_org() and person_id = p_person and cleared_at is null;
    perform audit_write('load_benchmark_clear', 'person', p_person::text);
    return jsonb_build_object('person', p_person, 'cleared', true);
  end if;
  if p_low is null or p_high is null or p_review is null or p_low < 0 or p_high < p_low or p_review < p_high or p_review > 99 then
    raise exception 'Give a healthy range (low to high) and a review line at or above it' using errcode = '22023'; end if;
  insert into load_benchmark (org_id, person_id, healthy_low, healthy_high, review_above, note, set_by)
    values (current_org(), p_person, p_low, p_high, p_review, nullif(left(btrim(coalesce(p_note, '')), 300), ''), me)
    on conflict (org_id, person_id) do update set healthy_low = excluded.healthy_low, healthy_high = excluded.healthy_high, review_above = excluded.review_above,
      note = excluded.note, set_by = excluded.set_by, set_at = now(), cleared_at = null;
  perform audit_write('load_benchmark_set', 'person', p_person::text);
  return jsonb_build_object('person', p_person, 'healthy', jsonb_build_array(p_low, p_high), 'reviewAbove', p_review);
end $$;

-- Leadership's delivery read: date moves of the last 30 days by reason, and the client waits.
create function pulse.pm_leadership() returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare tz text := org_time_zone(); today date := (now() at time zone org_time_zone())::date; v_moves jsonb; v_waits jsonb;
begin
  if not viewer_is('admin', 'leadership') then raise exception 'Leadership reads the delivery desk' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('reason', m.reason_kind, 'label', m.label, 'side', m.side, 'moves', m.moves, 'steps', m.steps, 'days', m.days, 'projects', m.projects) order by m.moves desc, m.reason_kind), '[]'::jsonb)
    into v_moves from (
      select d.reason_kind, max(coalesce(r->>'label', d.reason_kind)) label, max(coalesce(r->>'side', case when d.reason_kind like 'client%' then 'client' else 'us' end)) side,
             count(*)::int moves, sum(1 + coalesce(cardinality(d.moved), 0))::int steps, sum(greatest(0, d.to_due - d.from_due))::int days, count(distinct d.project_id)::int projects
        from project_date_change d
        left join project_plan pl on pl.org_id = d.org_id and pl.project_id = d.project_id
        left join delivery_template t on t.org_id = pl.org_id and t.key = pl.template_key
        left join lateral (select x from jsonb_array_elements(case when jsonb_typeof(t.definition->'reasons') = 'array' then t.definition->'reasons' else '[]'::jsonb end) x where x->>'key' = d.reason_kind limit 1) rr(r) on true
       where d.org_id = current_org() and d.changed_at > now() - interval '30 days' and d.from_due is not null and d.to_due is not null and d.to_due <> d.from_due
       group by d.reason_kind) m;
  select jsonb_build_object('open', count(*)::int, 'projects', count(distinct w.project_id)::int,
           'days', coalesce(sum(pm_work_days((w.since at time zone tz)::date, today)), 0)::int,
           'oldest', min((w.since at time zone tz)::date)::text)
    into v_waits from task_wait w join task t on t.id = w.task_id and t.deleted_at is null
   where w.org_id = current_org() and w.until is null and w.party = 'client';
  return jsonb_build_object('today', today, 'moves', v_moves, 'clientWaits', v_waits);
end $$;

revoke all on function pulse.load_benchmark_set(uuid, numeric, numeric, numeric, text), pulse.pm_leadership() from public;
grant execute on function pulse.load_benchmark_set(uuid, numeric, numeric, numeric, text), pulse.pm_leadership() to pulse_api;

-- migrate:down
drop function if exists pulse.pm_leadership();
drop function if exists pulse.load_benchmark_set(uuid, numeric, numeric, numeric, text);
drop table if exists pulse.load_benchmark;
