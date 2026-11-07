-- migrate:up
-- EST-1238 (Willow Lane's quote loop, Wed 28 Oct 2026): an unanswered quotation comes back to its salesperson.
--   * Marking an issued quotation Sent schedules its first follow-up at the company's follow-up hour (09:00 unless set)
--     in the company's own time zone (org_time_zone), on the local sent date + follow-up days (2 unless set); while it
--     stays unanswered it repeats every follow-up days. erp_settings.followup_days = 0 switches it off for a company.
--   * Due work rides the workers' minute block beside the workflow tick (quote_followup_tick, per company, its own
--     transaction and statement timeout; one company's failure never stalls another): at most 100 quotations per
--     company per tick, skip-locked so two ticks never take the same one. Each occurrence keeps one open follow-up task for the
--     salesperson (moved, or made again once finished; never two) and one fixed notice (task.due_soon, keyed by the
--     occurrence). After downtime only the latest due occurrence is told, and the next one is in the future.
--   * The salesperson: the quotation's salesperson_id where agent-key drafts carry one (EST-1248), else whoever marked
--     it Sent, else whoever drafted it; always an active staff member, never a service key.
--   * The salesperson (or an ERP writer) records "customer replied" (the sequence pauses), "call later" (it continues
--     from now) or closes it with an outcome. Accepted, declined, converted or cancelled quotations stop it and cancel
--     the open follow-up task. Finishing the task alone changes nothing about the quotation. Each step is in the ERP log.
alter table pulse.erp_settings add column followup_days smallint not null default 2 check(followup_days between 0 and 30),
 add column followup_hour smallint not null default 9 check(followup_hour between 0 and 23);

create table pulse.erp_followup(
 org_id uuid not null references pulse.org(id), document_id uuid primary key references pulse.erp_document(id) on delete cascade,
 person_id uuid references pulse.person(id),
 state text not null default 'scheduled' check(state in ('scheduled','answered','closed','stopped')),
 next_due_at timestamptz, last_due_at timestamptz, occurrences int not null default 0,
 task_id uuid references pulse.task(id) on delete set null,
 answered_at timestamptz, answered_by uuid references pulse.person(id), answer_note text check(length(answer_note)<=500),
 closed_at timestamptz, closed_by uuid references pulse.person(id),
 close_outcome text check(close_outcome in ('converted','not_interested','lost','other')), close_note text check(length(close_note)<=500),
 stopped_reason text check(stopped_reason in ('accepted','declined','converted','cancelled','off')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check((state='scheduled')=(next_due_at is not null)));
create index erp_followup_due on pulse.erp_followup(org_id,next_due_at) where state='scheduled';
alter table pulse.erp_followup enable row level security;
alter table pulse.erp_followup force row level security;
create policy tenant on pulse.erp_followup using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
revoke all on pulse.erp_followup from public, pulse_api, pulse_worker;

-- The follow-up hour on the local date `p_days` after `p_from`, in the company's time zone.
create function pulse.erp_followup_slot(p_from timestamptz,p_days int,p_hour int) returns timestamptz language sql stable set search_path=pulse,pg_temp as $$
 select ((((p_from at time zone org_time_zone())::date+p_days)+make_time(p_hour,0,0)) at time zone org_time_zone())
$$;
-- salesperson_id is read through to_jsonb, so this works before and after EST-1248 adds the column.
create function pulse.erp_followup_person(d pulse.erp_document) returns uuid language sql stable security definer set search_path=pulse,pg_temp as $$
 select p.id from (values(1,nullif(to_jsonb(d)->>'salesperson_id','')::uuid),(2,d.sent_by),(3,d.created_by)) c(rank,id)
  join person p on p.id=c.id and p.org_id=d.org_id and p.side='staff' and p.status='active' order by c.rank limit 1
$$;
create function pulse.erp_followup_task_end(p_task uuid,p_status text) returns void language sql security definer set search_path=pulse,pg_temp as $$
 update task set status=p_status,updated_at=now() where id=p_task and status in ('open','in_progress','blocked') and deleted_at is null
$$;
create function pulse.erp_followup_stop(p_doc uuid,p_reason text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare f erp_followup;
begin
 update erp_followup set state='stopped',stopped_reason=p_reason,next_due_at=null,updated_at=now()
  where document_id=p_doc and state in ('scheduled','answered') returning * into f;
 if f.document_id is null then return;end if;
 perform erp_followup_task_end(f.task_id,'cancelled');
 perform erp_log('document',p_doc,'followup_stopped',jsonb_build_object('reason',p_reason));
end $$;

create function pulse.erp_followup_follow() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare s erp_settings;due timestamptz;
begin
 if new.doc_type<>'quotation' then return null;end if;
 if old.sent_at is null and new.sent_at is not null and new.status='sent' then
  select * into s from erp_settings where org_id=new.org_id;
  if coalesce(s.followup_days,2)=0 then return null;end if;
  due:=erp_followup_slot(new.sent_at,coalesce(s.followup_days,2),coalesce(s.followup_hour,9));
  insert into erp_followup(org_id,document_id,person_id,next_due_at) values(new.org_id,new.id,erp_followup_person(new),due) on conflict(document_id) do nothing;
  if found then perform erp_log('document',new.id,'followup_scheduled',jsonb_build_object('due',due));end if;
 elsif new.status in ('accepted','declined','converted','cancelled') and new.status is distinct from old.status then
  perform erp_followup_stop(new.id,new.status);
 end if;
 return null;
end $$;
create trigger erp_followup_follow after update of status,sent_at on pulse.erp_document for each row execute function pulse.erp_followup_follow();

create function pulse.quote_followup_tick(p_now timestamptz default now()) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare f erp_followup;d erp_document;s erp_settings;who uuid;tid uuid;cur timestamptz;nxt timestamptz;days int;hr int;buyer text;num text;n int:=0;told int:=0;
begin
 select * into s from erp_settings where org_id=current_org();
 days:=coalesce(s.followup_days,2);hr:=coalesce(s.followup_hour,9);
 for f in select * from erp_followup where org_id=current_org() and state='scheduled' and next_due_at<=p_now order by next_due_at limit 100 for update skip locked loop
  select * into d from erp_document where id=f.document_id;
  if d.status<>'sent' or days=0 then
   perform erp_followup_stop(d.id,case when days=0 then 'off' when d.status in ('accepted','declined','converted') then d.status else 'cancelled' end);
   continue;
  end if;
  cur:=f.next_due_at;
  for i in 1..1000 loop nxt:=erp_followup_slot(cur,days,hr);exit when nxt>p_now;cur:=nxt;end loop;
  who:=coalesce((select id from person where id=f.person_id and side='staff' and status='active'),erp_followup_person(d));
  tid:=(select id from task where id=f.task_id and status in ('open','in_progress','blocked') and deleted_at is null);
  -- A replaced salesperson gets a task of their own: the old one (owner locked) is cancelled, a new one is made below.
  if tid is not null and (select coalesce(owner_id,assignee_person_id) from task where id=tid) is distinct from who then
   perform erp_followup_task_end(tid,'cancelled');tid:=null;
  end if;
  buyer:=left(coalesce(nullif(btrim(d.buyer->>'name'),''),'the client'),80);num:=coalesce(d.number,'');
  if who is not null then
   if tid is null then
    insert into task(org_id,title,status,source,source_ref,created_by,created_at,edited_by,updated_at,priority,due_at,locked,notes,owner_id,assignee_person_id,assigned_at)
    values(current_org(),left('Follow up: quotation '||num||' for '||buyer,300),'open','quote_followup',d.id::text,who,now(),who,now(),'normal',cur,'{title,owner_id}',
     'The customer has not answered quotation '||num||' yet. Call them, then record their answer on the quotation: replied, call later, or closed with how it ended. Finishing this task alone does not close the quotation.',
     who,who,now()) returning id into tid;
   else
    update task set due_at=cur,updated_at=now() where id=tid;
   end if;
   -- One fixed notice per occurrence through the task helper (no quotation number or buyer in notices or their copies).
   if task_notify(who,'task.due_soon',tid,'quote_followup:'||d.id||':'||to_char(cur at time zone 'UTC','YYYYMMDD"T"HH24MI'),'Follow up on a quotation today') is not null then told:=told+1;end if;
  end if;
  update erp_followup set person_id=coalesce(who,person_id),task_id=coalesce(tid,task_id),last_due_at=cur,next_due_at=nxt,occurrences=occurrences+1,updated_at=now()
   where document_id=f.document_id;
  perform erp_log('document',d.id,'followup_due',jsonb_build_object('due',cur,'next',nxt,'told',who is not null));
  n:=n+1;
 end loop;
 return jsonb_build_object('due',n,'told',told);
end $$;

-- What the salesperson (or anyone who reads ERP) sees; null otherwise.
create function pulse.erp_followup_view(p_doc uuid) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('documentId',f.document_id,'state',f.state,'nextDueAt',f.next_due_at,'lastDueAt',f.last_due_at,'occurrences',f.occurrences,'taskId',f.task_id,
  'salesperson',case when p.id is not null then jsonb_build_object('id',p.id,'name',p.display_name) end,
  'answer',case when f.answered_at is not null then jsonb_build_object('at',f.answered_at,'note',f.answer_note) end,
  'closed',case when f.closed_at is not null then jsonb_build_object('at',f.closed_at,'outcome',f.close_outcome,'note',f.close_note) end,
  'stoppedReason',f.stopped_reason,'canAnswer',f.state in ('scheduled','answered') and (f.person_id=current_viewer() or erp_can(true)))
 from erp_followup f left join person p on p.id=f.person_id
 where f.document_id=p_doc and f.org_id=current_org() and current_viewer() is not null and (f.person_id=current_viewer() or erp_can(false))
$$;
create function pulse.erp_followup_answer(p_doc uuid,p_action text,p_outcome text default null,p_note text default null) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare f erp_followup;me uuid:=current_viewer();s erp_settings;v_note text:=nullif(btrim(coalesce(p_note,'')),'');
begin
 select * into f from erp_followup where document_id=p_doc and org_id=current_org() for update;
 if f.document_id is null or me is null then raise exception 'No follow-up for this quotation' using errcode='P0002';end if;
 if f.person_id is distinct from me and not erp_can(true) then raise exception 'Only the quotation''s salesperson or an ERP writer answers its follow-up' using errcode='42501';end if;
 if f.state in ('closed','stopped') then raise exception 'This follow-up is closed' using errcode='22023';end if;
 if length(v_note)>500 then raise exception 'Keep the note under 500 characters' using errcode='22023';end if;
 if p_action='replied' then
  update erp_followup set state='answered',next_due_at=null,answered_at=now(),answered_by=me,answer_note=v_note,updated_at=now() where document_id=p_doc;
  perform erp_followup_task_end(f.task_id,'done');
 elsif p_action='later' then
  select * into s from erp_settings where org_id=current_org();
  update erp_followup set state='scheduled',next_due_at=erp_followup_slot(now(),greatest(coalesce(s.followup_days,2),1),coalesce(s.followup_hour,9)),updated_at=now()
   where document_id=p_doc;
 elsif p_action='close' then
  if p_outcome is null or p_outcome not in ('converted','not_interested','lost','other') then raise exception 'Choose how it ended' using errcode='22023';end if;
  update erp_followup set state='closed',next_due_at=null,closed_at=now(),closed_by=me,close_outcome=p_outcome,close_note=v_note,updated_at=now() where document_id=p_doc;
  perform erp_followup_task_end(f.task_id,'cancelled');
 else raise exception 'Unknown action' using errcode='22023';
 end if;
 perform erp_log('document',p_doc,'followup_'||p_action,jsonb_build_object('outcome',p_outcome,'note',v_note));
 return erp_followup_view(p_doc);
end $$;

revoke all on function pulse.erp_followup_slot(timestamptz,int,int),pulse.erp_followup_person(pulse.erp_document),pulse.erp_followup_task_end(uuid,text),
 pulse.erp_followup_stop(uuid,text),pulse.erp_followup_follow(),pulse.quote_followup_tick(timestamptz),pulse.erp_followup_view(uuid),
 pulse.erp_followup_answer(uuid,text,text,text) from public;
grant execute on function pulse.erp_followup_view(uuid),pulse.erp_followup_answer(uuid,text,text,text) to pulse_api;
grant execute on function pulse.quote_followup_tick(timestamptz) to pulse_worker;

-- migrate:down
-- Forward-only: follow-up history is kept.
