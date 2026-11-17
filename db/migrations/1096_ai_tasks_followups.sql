-- migrate:up
-- AI-TASKS follow-ups (seen on pulse-dev with the real model, 26 Oct 2026), patched in place on 1064's functions (each
-- shape checked):
--  * The phone-number mask in an AI employee's task context also hid a client's RERA number ("P5210001…" became
--    "P[phone]"), so the AI asked the client to resend it; ISO dates were masked too. A phone number is now digit groups
--    (2-4, 3-5, 3-5 digits, spaces or dashes between, an optional +) with no letter or digit beside it: RERA and GST
--    numbers, dates, amounts and flat numbers stay as written.
--  * A colleague the AI gives a sub-task to could not open the task it belongs to, so could not answer there: they now
--    follow it (watcher), like a colleague the AI mentions.
--  * What people wrote on its sub-tasks (the note they finished it with, their latest comment) is in the AI's context; it
--    saw only the titles and states and rightly said the findings were missing.
--  * Its notifications name it in full ("Project Coordinator (AI) asked you on …"), not by a first name ("Project").
do $$
declare d text; c text;
begin
  d := pg_get_functiondef('pulse.agent_task_dispatch(uuid,uuid,text,text)'::regprocedure);
  c := replace(d, $x$'\+?[0-9][0-9 -]{8,}[0-9]'$x$, $x$'(?<![A-Za-z0-9])\+?[0-9]{2,4}[ -]?[0-9]{3,5}[ -]?[0-9]{3,5}(?![0-9A-Za-z])'$x$);
  c := replace(c, $x$'dueOn', (c.due_at at time zone org_time_zone())::date::text) order by c.created_at), '[]'::jsonb)$x$,
    $x$'dueOn', (c.due_at at time zone org_time_zone())::date::text,
                    'note', (select left(ev.note, 600) from task_event ev where ev.task_id = c.id and ev.kind = 'status' and ev.note is not null order by ev.at desc limit 1),
                    'latest', (select left(wc.body, 800) from work_comment wc where wc.task_id = c.id and wc.removed_at is null order by wc.created_at desc limit 1)) order by c.created_at), '[]'::jsonb)$x$);
  if c = d or position('(?<![A-Za-z0-9])' in c) = 0 or position($x$'latest', (select left(wc.body, 800)$x$ in c) = 0 then
    raise exception 'agent_task_dispatch changed shape (AI-TASKS 1096)'; end if;
  execute c;

  d := pg_get_functiondef('pulse.agent_task_act(uuid,jsonb,uuid)'::regprocedure);
  c := replace(d, $x$      perform task_event_add(nid, 'created', null, ttitle);$x$,
    $x$      -- AI-TASKS 1096: whoever does the sub-task follows the task it belongs to (they answer there).
      if not work_task_person(t.id, who) then insert into task_member(org_id, task_id, person_id, role, added_by) values (current_org(), t.id, who, 'watcher', me) on conflict do nothing; end if;
      perform task_event_add(nid, 'created', null, ttitle);$x$);
  -- An AI employee is named in full in what it tells people ("Project asked you on …" was "Project Coordinator (AI)").
  c := replace(replace(c, 'work_first_name(me) ||', 'me_name ||'), $x$me_name || ' (AI) gave you$x$, $x$me_name || ' gave you$x$);
  if c = d or position('work_first_name(me)' in c) > 0 then raise exception 'agent_task_act changed shape (AI-TASKS 1096)'; end if;
  execute c;
end $$;

-- migrate:down
-- Forward-only.
