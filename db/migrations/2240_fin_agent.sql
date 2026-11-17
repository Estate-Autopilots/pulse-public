-- migrate:up
-- FIN-AGENT (owner, 17 Nov 2026: "a Finance agent with every depth … every time it analyses something it derives
-- heuristics, memories, pattern scripts; it can make its own tools … long jobs split into a fast reply and a heavy
-- worker"). Generic for every AI employee, finance first:
--  * pulse.agent_job: heavy work an AI employee runs in the sandbox (services/coworker/sandbox.mjs): queued → running →
--    done / failed, a progress line people see live (the chat message it opened is edited in place), rows, time, tokens
--    and model calls, which learned skills it used. Files: a chat message's files, or uploaded in parts (big statements).
--  * pulse.agent_skill / agent_skill_version: what an AI employee learned as a reusable, versioned, tested tool (a parser
--    for one bank's layout, categoriser rules learned from people's decisions). Proposed by the AI with its test result;
--    only leadership with the Money plan permission or an admin publishes; jobs use published skills before any guess or
--    model call, and count their uses and the model calls they saved.
--  * pulse.fin_review_item: what a finance job proposes, one bank line each, with flags (suspicious, unclear category,
--    missing document, possible duplicate) and plain reasons. A person confirms (saved through the standard import's
--    own pulse.money_statement_save, so one source of truth) or sets it aside. Unique per line, so a re-run or an
--    overlapping statement never makes a second copy.
-- Production finance data is only read by jobs; nothing moves money; confirming is a person's act.

create table pulse.agent_job (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 agent_id uuid not null references pulse.person(id),
 kind text not null check(kind ~ '^[a-z][a-z0-9_]*\.[a-z0-9_.-]{1,40}$'),
 title text not null check(length(title) between 1 and 200),
 status text not null default 'queued' check(status in ('uploading','queued','running','done','failed','cancelled')),
 progress int not null default 0 check(progress between 0 and 100),
 status_line text check(length(status_line)<=300),
 steps jsonb not null default '[]' check(jsonb_typeof(steps)='array'),
 asked_by uuid references pulse.person(id),
 channel_id uuid, status_message_id uuid, source_message_id uuid,
 input jsonb not null default '{}' check(jsonb_typeof(input)='object' and octet_length(input::text)<=65536),
 result jsonb check(result is null or octet_length(result::text)<=262144),
 error text check(length(error)<=500),
 rows_in bigint not null default 0, rows_out bigint not null default 0,
 cpu_seconds numeric(12,2) not null default 0, wall_seconds numeric(12,2) not null default 0,
 tokens int not null default 0 check(tokens>=0), model_calls int not null default 0 check(model_calls>=0),
 skills_used jsonb not null default '{}' check(jsonb_typeof(skills_used)='object'),
 lease_token uuid, lease_until timestamptz, attempts int not null default 0,
 created_at timestamptz not null default now(), started_at timestamptz, finished_at timestamptz,
 unique(org_id,id)
);
create index agent_job_queue on pulse.agent_job(org_id,agent_id,status,created_at);
create index agent_job_recent on pulse.agent_job(org_id,created_at desc);

create table pulse.agent_job_file (
 org_id uuid not null references pulse.org(id),
 job_id uuid not null references pulse.agent_job(id) on delete cascade,
 file_no int not null check(file_no between 0 and 19),
 name text not null check(length(name) between 1 and 200),
 mime text not null default 'application/octet-stream' check(length(mime)<=100),
 size bigint not null default 0 check(size between 0 and 1073741824),
 parts int not null default 1 check(parts between 1 and 256),
 chat_file_id uuid,
 primary key(job_id,file_no)
);
-- A big file arrives in parts of up to 4 MB (idempotent: the same part again changes nothing).
create table pulse.agent_job_part (
 org_id uuid not null references pulse.org(id),
 job_id uuid not null, file_no int not null, part_no int not null check(part_no between 0 and 255),
 bytes bytea not null check(octet_length(bytes) between 1 and 4194304),
 sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
 primary key(job_id,file_no,part_no),
 foreign key(job_id,file_no) references pulse.agent_job_file(job_id,file_no) on delete cascade
);

create table pulse.agent_skill (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 name text not null check(name ~ '^[a-z0-9][a-z0-9-]{2,60}$'),
 title text not null check(length(title) between 1 and 160),
 kind text not null check(kind in ('parser','categoriser','rule','script','report')),
 area text not null default 'finance' check(area in ('finance','billing','work','people','general')),
 agent_id uuid references pulse.person(id),
 status text not null default 'proposed' check(status in ('proposed','published','retired')),
 version int not null default 1 check(version>=1),
 published_version int,
 uses bigint not null default 0, lines_handled bigint not null default 0, model_calls_saved bigint not null default 0,
 last_used_at timestamptz,
 created_at timestamptz not null default now(),
 published_by uuid references pulse.person(id), published_at timestamptz,
 retired_by uuid references pulse.person(id), retired_at timestamptz,
 unique(org_id,name), unique(org_id,id)
);
create table pulse.agent_skill_version (
 org_id uuid not null references pulse.org(id),
 skill_id uuid not null references pulse.agent_skill(id) on delete cascade,
 version int not null check(version>=1),
 body jsonb not null check(jsonb_typeof(body)='object' and octet_length(body::text)<=262144),
 code text check(length(code)<=65536),
 tests jsonb not null default '[]' check(jsonb_typeof(tests)='array' and octet_length(tests::text)<=131072),
 test_result jsonb check(test_result is null or jsonb_typeof(test_result)='object'),
 why text check(length(why)<=600),
 made_by uuid references pulse.person(id), made_in_job uuid references pulse.agent_job(id) on delete set null,
 created_at timestamptz not null default now(),
 primary key(skill_id,version)
);

create table pulse.fin_review_item (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 job_id uuid not null references pulse.agent_job(id),
 agent_id uuid not null references pulse.person(id),
 line_key text not null check(line_key ~ '^[a-f0-9]{64}$'),
 file_name text check(length(file_name)<=200), bank text check(length(bank)<=40), account text check(length(account)<=80),
 txn_date date not null check(txn_date between date '2000-01-01' and date '2100-01-01'),
 amount_minor bigint not null check(amount_minor between 1 and 900000000000000),
 direction text not null check(direction in ('in','out')),
 narration text check(length(narration)<=200), channel text check(length(channel)<=12),
 reference text check(length(reference)<=60), counterparty text check(length(counterparty)<=80),
 category text check(length(category)<=60),
 kind text check(kind in ('expense','income','bill','refund','transfer')),
 confidence numeric(3,2) check(confidence between 0 and 1),
 flags text[] not null default '{}' check(flags <@ array['suspicious','unclear_category','missing_document','possible_duplicate']::text[]),
 reasons text[] not null default '{}' check(cardinality(reasons)<=4),
 match jsonb check(match is null or jsonb_typeof(match)='object'),
 source text check(length(source)<=80),
 status text not null default 'open' check(status in ('open','confirmed','set_aside')),
 decided_category text check(length(decided_category)<=60),
 decided_by uuid references pulse.person(id), decided_at timestamptz, saved boolean not null default false,
 created_at timestamptz not null default now(),
 unique(org_id,line_key)
);
create index fin_review_open on pulse.fin_review_item(org_id,status,txn_date desc);
create index fin_review_job on pulse.fin_review_item(org_id,job_id);
create index fin_review_who on pulse.fin_review_item(org_id,lower(counterparty)) where status<>'open';

-- Who reads: a person with Finance (pulse.fin_entry_can, as Finance → Entries), or the AI employee whose job it is.
create function pulse.fin_agent_reads(p_agent uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select case when agent_session() is not null then agent_session()=p_agent else fin_entry_can(false) end
$$;
create function pulse.skill_can_publish() returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select agent_session() is null and current_viewer() is not null and (fin_entry_approver() or viewer_is('admin'))
$$;

do $$ declare t text;begin
 foreach t in array array['agent_job','agent_job_file','agent_job_part','agent_skill','agent_skill_version','fin_review_item'] loop
  execute format('alter table pulse.%I enable row level security',t);
  execute format('alter table pulse.%I force row level security',t);
  execute format('create policy tenant_isolation on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
 end loop;
 foreach t in array array['agent_job','agent_job_file','agent_skill','agent_skill_version','fin_review_item'] loop
  execute format('grant select on pulse.%I to pulse_api',t);
 end loop;
end $$;
-- The checks are uncorrelated subqueries, so each runs once per query (an InitPlan), not once per row: with a definer
-- function per row, a company with 150,000 lines to check took 300 s to open the page.
create policy agent_job_read on pulse.agent_job as restrictive for select to pulse_api
 using(case when (select pulse.agent_session()) is not null then agent_id=(select pulse.agent_session()) else (select pulse.fin_entry_can(false)) end);
create policy agent_job_file_read on pulse.agent_job_file as restrictive for select to pulse_api using(exists(select 1 from pulse.agent_job j where j.id=job_id));
create policy fin_review_read on pulse.fin_review_item as restrictive for select to pulse_api
 using(case when (select pulse.agent_session()) is not null then agent_id=(select pulse.agent_session()) else (select pulse.fin_entry_can(false)) end);
-- Skills: every colleague with Finance sees the company's finance skills; an AI employee sees its company's published
-- skills and the ones it proposed.
create policy agent_skill_read on pulse.agent_skill as restrictive for select to pulse_api
 using(case when (select pulse.agent_session()) is not null then status='published' or agent_id=(select pulse.agent_session())
  else (select pulse.fin_entry_can(false)) or (select pulse.viewer_is('admin')) end);
create policy agent_skill_version_read on pulse.agent_skill_version as restrictive for select to pulse_api using(exists(select 1 from pulse.agent_skill s where s.id=skill_id));
grant select,insert,update,delete on pulse.agent_job,pulse.agent_job_file,pulse.agent_job_part,pulse.agent_skill,pulse.agent_skill_version,pulse.fin_review_item to pulse_worker;
create trigger audit_mutation after insert or update or delete on pulse.agent_skill for each row execute function pulse.audit_mutation();
create trigger audit_mutation after insert or update or delete on pulse.agent_skill_version for each row execute function pulse.audit_mutation();

-- What kind of job an AI employee may run: finance jobs need its Billing (finance and billing) tool.
create function pulse.agent_job_allowed(p_agent uuid, p_kind text) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from agent_member m where m.person_id=p_agent and m.disabled_at is null
  and case split_part(p_kind,'.',1) when 'fin' then 'billing'=any(m.tools) when 'work' then 'tasks'=any(m.tools) else true end)
$$;

-- The line people see in the chat while a job runs, and when it ends.
create function pulse.agent_job_words(j pulse.agent_job) returns text language sql immutable set search_path=pulse,pg_temp as $$
 select case j.status
  when 'queued' then '⏳ '||j.title||E'\nIn the queue. I''ll start in a moment.'
  when 'running' then '⏳ '||j.title||' · '||j.progress||E'%\n'||coalesce(j.status_line,'Working on it…')
  when 'done' then '✅ '||j.title||E'\n'||coalesce(j.status_line,'Done.')
  when 'failed' then '⚠️ '||j.title||E'\n'||coalesce(j.error,'It stopped.')
  else '✖ '||j.title||E'\nStopped.' end
$$;
create function pulse.agent_job_tell(p_job uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare j agent_job;
begin
 select * into j from agent_job where id=p_job;
 if j.status_message_id is null then return; end if;
 update chat_message set body=left(agent_job_words(j),4000),edited_at=clock_timestamp(),updated_at=clock_timestamp()
  where id=j.status_message_id and author_id=j.agent_id and removed_at is null;
end $$;

-- AI employee: open a job from a chat message (the fast reply: it answers at once, and that message shows the
-- progress). Files are that conversation's own files.
create function pulse.agent_job_create(p_kind text, p_title text, p_channel uuid, p_source uuid, p_input jsonb, p_files uuid[], p_client uuid)
 returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=agent_session(); jid uuid; mid uuid; f record; n int:=0; prior agent_job;
begin
 if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
 if not agent_job_allowed(me,p_kind) then raise exception 'This AI employee is not switched on for this kind of work' using errcode='42501'; end if;
 if p_channel is not null and (not chat_has(p_channel) or chat_client_facing(p_channel)) then raise exception 'Open a job only in a conversation with colleagues' using errcode='42501'; end if;
 if cardinality(coalesce(p_files,'{}'))>20 then raise exception 'Up to 20 files in one job' using errcode='22023'; end if;
 select * into prior from agent_job where agent_id=me and input->>'clientKey'=p_client::text;
 if found then return jsonb_build_object('id',prior.id,'statusMessageId',prior.status_message_id,'again',true); end if;
 insert into agent_job(org_id,agent_id,kind,title,asked_by,channel_id,source_message_id,input)
 values(current_org(),me,p_kind,left(btrim(p_title),200),(select author_id from chat_message where id=p_source and channel_id=p_channel),p_channel,p_source,
  coalesce(p_input,'{}'::jsonb)||jsonb_build_object('clientKey',p_client)) returning id into jid;
 for f in select cf.id,cf.name,cf.mime,octet_length(cf.bytes) size from unnest(coalesce(p_files,'{}')) with ordinality u(id,o) join pulse_priv.chat_file cf on cf.id=u.id
   where cf.org_id=current_org() and cf.channel_id=p_channel order by u.o loop
  insert into agent_job_file(org_id,job_id,file_no,name,mime,size,parts,chat_file_id) values(current_org(),jid,n,f.name,f.mime,f.size,1,f.id);
  n:=n+1;
 end loop;
 if cardinality(coalesce(p_files,'{}'))>0 and n=0 then raise exception 'Those files are not in this conversation' using errcode='22023'; end if;
 if p_channel is not null then
  mid:=chat_send(p_channel,'⏳ '||left(btrim(p_title),200)||E'\nGot it. Give me a few seconds: I''m opening the files, and I''ll keep this message up to date.',null,'[]'::jsonb,p_client,null);
  update agent_job set status_message_id=mid where id=jid;
 end if;
 return jsonb_build_object('id',jid,'statusMessageId',mid,'files',n);
end $$;

-- A person (Finance writers) starts a job from the Finance agent page, then uploads each file in parts.
create function pulse.fin_agent_job_start(p_agent uuid, p_title text, p_files jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare jid uuid; f jsonb; n int:=0;
begin
 if agent_session() is not null or not fin_entry_can(true) then raise exception 'Starting a Finance job is for leadership and the Finance role' using errcode='42501'; end if;
 if not agent_job_allowed(p_agent,'fin.ingest') then raise exception 'Choose an AI employee with Finance & billing switched on' using errcode='22023'; end if;
 if jsonb_typeof(p_files)<>'array' or jsonb_array_length(p_files) not between 1 and 20 then raise exception 'Choose 1 to 20 files' using errcode='22023'; end if;
 insert into agent_job(org_id,agent_id,kind,title,asked_by,status,input) values(current_org(),p_agent,'fin.ingest',left(coalesce(nullif(btrim(p_title),''),'Read the statements'),200),current_viewer(),'uploading','{}')
  returning id into jid;
 for f in select value from jsonb_array_elements(p_files) loop
  if coalesce(f->>'name','')='' or coalesce((f->>'size')::bigint,-1) not between 1 and 1073741824 or coalesce((f->>'parts')::int,0) not between 1 and 256 then
   raise exception 'Each file needs a name, a size up to 1 GB and its number of parts' using errcode='22023'; end if;
  insert into agent_job_file(org_id,job_id,file_no,name,mime,size,parts) values(current_org(),jid,n,left(regexp_replace(f->>'name','[\x00-\x1f/\\]','_','g'),200),left(coalesce(f->>'mime','application/octet-stream'),100),(f->>'size')::bigint,(f->>'parts')::int);
  n:=n+1;
 end loop;
 perform audit_write('import','finance.agent_job',jid::text,array['files']);
 return jid;
end $$;
create function pulse.fin_agent_job_part(p_job uuid, p_file int, p_part int, p_bytes bytea) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare j agent_job; f agent_job_file; have int;
begin
 select * into j from agent_job where id=p_job and org_id=current_org();
 if not found or agent_session() is not null or j.asked_by is distinct from current_viewer() or not fin_entry_can(true) then raise exception 'Upload into your own Finance job' using errcode='42501'; end if;
 if j.status<>'uploading' then raise exception 'This job has all its files already' using errcode='22023'; end if;
 select * into f from agent_job_file where job_id=p_job and file_no=p_file;
 if not found or p_part not between 0 and f.parts-1 then raise exception 'No such file part' using errcode='22023'; end if;
 insert into agent_job_part(org_id,job_id,file_no,part_no,bytes,sha256) values(current_org(),p_job,p_file,p_part,p_bytes,encode(sha256(p_bytes),'hex'))
  on conflict(job_id,file_no,part_no) do nothing;
 select count(*) into have from agent_job_part where job_id=p_job;
 if have=(select sum(parts) from agent_job_file where job_id=p_job) then update agent_job set status='queued' where id=p_job; end if;
 return jsonb_build_object('parts',have,'ready',have=(select sum(parts) from agent_job_file where job_id=p_job));
end $$;

-- AI employee: take its next job (or one whose lease ran out), for 15 minutes; renew with each progress step.
create function pulse.agent_job_claim(p_kinds text[]) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=agent_session(); j agent_job; tok uuid:=gen_random_uuid();
begin
 if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
 select * into j from agent_job where agent_id=me and org_id=current_org()
  and (status='queued' or (status='running' and lease_until<now())) and (p_kinds is null or kind=any(p_kinds))
  order by created_at for update skip locked limit 1;
 if not found then return null; end if;
 if j.attempts>=3 then
  update agent_job set status='failed',error='It stopped three times; ask me again with a smaller file.',finished_at=now(),lease_token=null where id=j.id;
  perform agent_job_tell(j.id); return null;
 end if;
 update agent_job set status='running',lease_token=tok,lease_until=now()+interval '15 minutes',attempts=attempts+1,started_at=coalesce(started_at,now()),
  status_line=coalesce(status_line,'Starting…') where id=j.id returning * into j;
 perform agent_job_tell(j.id);
 return jsonb_build_object('id',j.id,'kind',j.kind,'title',j.title,'leaseToken',tok,'input',j.input-'clientKey','channelId',j.channel_id,
  'files',(select coalesce(jsonb_agg(jsonb_build_object('no',file_no,'name',name,'mime',mime,'size',size,'parts',parts) order by file_no),'[]') from agent_job_file where job_id=j.id));
end $$;
create function pulse.agent_job_mine(p_job uuid, p_lease uuid) returns pulse.agent_job language plpgsql security definer set search_path=pulse,pg_temp as $$
declare j agent_job;
begin
 select * into j from agent_job where id=p_job and org_id=current_org() and agent_id=agent_session();
 if not found or j.status<>'running' or j.lease_token is distinct from p_lease then raise exception 'This job is not yours to work on now' using errcode='42501'; end if;
 return j;
end $$;
-- A part of one of the job's files (a chat file is one part).
create function pulse.agent_job_bytes(p_job uuid, p_lease uuid, p_file int, p_part int) returns bytea language plpgsql security definer set search_path=pulse,pg_temp as $$
declare j agent_job:=agent_job_mine(p_job,p_lease); f agent_job_file; b bytea;
begin
 select * into f from agent_job_file where job_id=j.id and file_no=p_file;
 if not found then raise exception 'No such file' using errcode='22023'; end if;
 if f.chat_file_id is not null then select bytes into b from pulse_priv.chat_file where id=f.chat_file_id and org_id=current_org();
 else select bytes into b from agent_job_part where job_id=j.id and file_no=p_file and part_no=p_part; end if;
 if b is null then raise exception 'That part is not here' using errcode='22023'; end if;
 return b;
end $$;
-- What the job may use: the company's published skills (and this AI's own proposals), open invoices to match, and
-- what people decided before (counterparty → category), so it learns.
create function pulse.agent_job_context(p_job uuid, p_lease uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare j agent_job:=agent_job_mine(p_job,p_lease); inv jsonb:='[]';
begin
 begin
  select coalesce(jsonb_agg(jsonb_build_object('no',d.number,'amount',d.total,'gst',d.cgst+d.sgst+d.igst,'date',d.issue_date,'client',coalesce(c.name,d.buyer->>'name'))),'[]') into inv
   from erp_document d left join client c on c.id=d.client_id
   where d.org_id=current_org() and d.doc_type='invoice' and d.status in ('issued','sent','part_paid') and d.issue_date>current_date-400 limit 3000;
 exception when others then inv:='[]';
 end;
 return jsonb_build_object(
  'skills',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'kind',s.kind,'status',s.status,'version',v.version,'body',v.body,'tests',v.tests)),'[]')
    from agent_skill s join agent_skill_version v on v.skill_id=s.id and v.version=case when s.status='published' then s.published_version else s.version end
    where s.org_id=current_org() and s.status<>'retired' and (s.status='published' or s.agent_id=j.agent_id)),
  'invoices',inv,
  -- A payment above the company's own approval limit (Finance → Entries settings, ₹50,000 to start) needs its bill.
  'largeMinor',coalesce((select approval_minor from fin_entry_settings where org_id=current_org()),5000000),
  'decisions',(select coalesce(jsonb_agg(x),'[]') from (select lower(counterparty) who,direction,coalesce(decided_category,category) category,count(*) n
    from fin_review_item where org_id=current_org() and status='confirmed' and counterparty is not null group by 1,2,3 order by n desc limit 500) x));
end $$;
create function pulse.agent_job_progress(p_job uuid, p_lease uuid, p_progress int, p_line text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare j agent_job:=agent_job_mine(p_job,p_lease);
begin
 update agent_job set progress=greatest(progress,least(99,greatest(0,coalesce(p_progress,0)))),status_line=left(coalesce(nullif(btrim(p_line),''),status_line),300),
  steps=case when coalesce(btrim(p_line),'')='' then steps else (steps||jsonb_build_array(jsonb_build_object('at',now(),'p',p_progress,'line',left(p_line,200)))) end,
  lease_until=now()+interval '15 minutes' where id=j.id;
 update agent_job set steps=(select jsonb_agg(e) from (select e from jsonb_array_elements(steps) with ordinality a(e,o) order by o desc limit 60) x) where id=j.id and jsonb_array_length(steps)>60;
 perform agent_job_tell(j.id);
end $$;
-- Up to 5,000 proposed lines at a time; a line already in Pulse (same line key) is skipped, so a retry or an
-- overlapping statement adds nothing twice.
create function pulse.agent_job_items(p_job uuid, p_lease uuid, p_items jsonb) returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare j agent_job:=agent_job_mine(p_job,p_lease); n int;
begin
 if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)>5000 then raise exception 'Send up to 5,000 lines at a time' using errcode='22023'; end if;
 insert into fin_review_item(org_id,job_id,agent_id,line_key,file_name,bank,account,txn_date,amount_minor,direction,narration,channel,reference,counterparty,category,kind,confidence,flags,reasons,match,source)
 select current_org(),j.id,j.agent_id,x."lineKey",left(x.file,200),left(x.bank,40),left(x.account,80),x.date,x."amountMinor",x.direction,
  left(regexp_replace(x.narration,'(?<![A-Za-z0-9])[0-9]([ -]?[0-9]){4,}(?![A-Za-z0-9])','•••','g'),200),left(x.channel,12),left(x.reference,60),left(x.counterparty,80),left(x.category,60),x.kind,
  least(1,greatest(0,x.confidence)),coalesce(array(select f from unnest(x.flags) f where f=any(array['suspicious','unclear_category','missing_document','possible_duplicate'])),'{}'),
  coalesce((select array_agg(left(r,200)) from (select r from unnest(x.reasons) r limit 4) rr),'{}'),case when jsonb_typeof(x.match)='object' then x.match end,left(x.source,80)
 from jsonb_to_recordset(p_items) x("lineKey" text,file text,bank text,account text,date date,"amountMinor" bigint,direction text,narration text,channel text,reference text,
  counterparty text,category text,kind text,confidence numeric,flags text[],reasons text[],match jsonb,source text)
 on conflict(org_id,line_key) do nothing;
 get diagnostics n=row_count;
 update agent_job set rows_out=rows_out+n,lease_until=now()+interval '15 minutes' where id=j.id;
 return n;
end $$;
-- A skill the AI learned, with its own test result: a new skill is proposed; a changed body is the next version.
create function pulse.agent_skill_propose(p_job uuid, p_lease uuid, p_skill jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare j agent_job:=agent_job_mine(p_job,p_lease); s agent_skill; v agent_skill_version; nm text:=p_skill->>'name';
begin
 if nm !~ '^[a-z0-9][a-z0-9-]{2,60}$' or coalesce(p_skill->>'kind','') not in ('parser','categoriser','rule','script','report') or jsonb_typeof(p_skill->'body')<>'object' then
  raise exception 'A skill needs a name, a kind and a body' using errcode='22023'; end if;
 select * into s from agent_skill where org_id=current_org() and name=nm for update;
 if not found then
  insert into agent_skill(org_id,name,title,kind,area,agent_id) values(current_org(),nm,left(coalesce(nullif(p_skill->>'title',''),nm),160),p_skill->>'kind',
   case when split_part(j.kind,'.',1)='fin' then 'finance' else 'general' end,j.agent_id) returning * into s;
 else
  if s.status='retired' then return jsonb_build_object('id',s.id,'retired',true); end if;
  select * into v from agent_skill_version where skill_id=s.id and version=s.version;
  if v.body=p_skill->'body' then
   update agent_skill_version set test_result=coalesce(p_skill->'testResult',test_result) where skill_id=s.id and version=s.version;
   return jsonb_build_object('id',s.id,'version',s.version,'same',true); end if;
  update agent_skill set version=version+1,status=case when status='published' then 'published' else 'proposed' end where id=s.id returning * into s;
 end if;
 insert into agent_skill_version(org_id,skill_id,version,body,code,tests,test_result,why,made_by,made_in_job)
 values(current_org(),s.id,s.version,p_skill->'body',left(p_skill->>'code',65536),coalesce(p_skill->'tests','[]'),p_skill->'testResult',left(p_skill->>'why',600),j.agent_id,j.id);
 return jsonb_build_object('id',s.id,'version',s.version,'new',s.version=1);
end $$;
create function pulse.agent_job_finish(p_job uuid, p_lease uuid, p_status text, p_line text, p_result jsonb, p_error text, p_stats jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare j agent_job:=agent_job_mine(p_job,p_lease); u record;
begin
 if p_status not in ('done','failed') then raise exception 'A job ends done or failed' using errcode='22023'; end if;
 update agent_job set status=p_status,progress=case when p_status='done' then 100 else progress end,status_line=left(coalesce(nullif(btrim(p_line),''),status_line),300),
  result=p_result,error=left(p_error,500),finished_at=now(),lease_token=null,lease_until=null,
  rows_in=coalesce((p_stats->>'rowsIn')::bigint,rows_in),cpu_seconds=coalesce((p_stats->>'cpuSeconds')::numeric,cpu_seconds),
  wall_seconds=extract(epoch from now()-coalesce(started_at,created_at)),tokens=tokens+coalesce((p_stats->>'tokens')::int,0),
  model_calls=model_calls+coalesce((p_stats->>'modelCalls')::int,0),skills_used=coalesce(p_stats->'skillsUsed','{}') where id=j.id;
 -- Each published skill it used: one more use, the lines it handled, one model call saved.
 for u in select key,value from jsonb_each_text(coalesce(p_stats->'skillsUsed','{}')) loop
  update agent_skill set uses=uses+1,lines_handled=lines_handled+coalesce(nullif(regexp_replace(u.value,'\D','','g'),'')::bigint,0),model_calls_saved=model_calls_saved+1,last_used_at=now()
   where org_id=current_org() and name=regexp_replace(split_part(u.key,'@',1),'^skill:','') and status='published';
 end loop;
 perform agent_job_tell(j.id);
end $$;
-- The AI's own record of a model call it made inside a job (categorising what no rule knew).
create function pulse.agent_job_model_use(p_job uuid, p_lease uuid, p_tokens int) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare j agent_job:=agent_job_mine(p_job,p_lease);
begin
 update agent_job set tokens=tokens+greatest(0,coalesce(p_tokens,0)),model_calls=model_calls+1 where id=j.id;
end $$;

-- People: confirm lines (saved through the standard statement import, one source of truth with Finance → Import),
-- set them aside, or open them again. Up to 2,000 at a time. A changed category is kept, so the AI learns from it.
create function pulse.fin_review_decide(p_ids uuid[], p_decision text, p_category text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare n int:=0; saved int:=0; rows jsonb;
begin
 if agent_session() is not null or not fin_entry_can(true) then raise exception 'Checking the AI''s lines is for leadership and the Finance role' using errcode='42501'; end if;
 if cardinality(coalesce(p_ids,'{}')) not between 1 and 2000 then raise exception 'Choose 1 to 2,000 lines' using errcode='22023'; end if;
 if p_decision not in ('confirm','set_aside','reopen') then raise exception 'Confirm, set aside or reopen' using errcode='22023'; end if;
 if p_category is not null and length(btrim(p_category)) not between 1 and 60 then raise exception 'A category is up to 60 characters' using errcode='22023'; end if;
 if p_decision='confirm' then
  if not (money_can('money.plan.write') and money_can('money.amount.read')) then raise exception 'Saving bank lines needs the Money permission, which leadership has' using errcode='42501'; end if;
  select jsonb_agg(jsonb_build_object('date',i.txn_date,'amount',(i.amount_minor/100.0)::text,'direction',case i.direction when 'in' then 'inflow' else 'outflow' end,'currency','INR',
    'vendor',coalesce(i.counterparty,i.narration,'Unknown'),'category',coalesce(nullif(btrim(p_category),''),i.category,'Uncategorised'),'reference_hash',i.line_key,
    'account_digest',encode(sha256(convert_to(current_org()::text||'|bank|'||coalesce(i.account,''),'UTF8')),'hex'),'date_basis','Statement date (Finance AI)',
    'minor_unit_scale',2,'original_amount_unit','major','reference_kind',case when i.reference is not null then 'provider_transaction' else 'source_row' end,
    'parser_issues',to_jsonb(i.flags)))
   into rows from fin_review_item i where i.id=any(p_ids) and i.status='open';
  if rows is not null then
   saved:=money_statement_save(rows,'bank');
  end if;
  update fin_review_item set status='confirmed',decided_category=coalesce(nullif(btrim(p_category),''),category),decided_by=current_viewer(),decided_at=now(),saved=true
   where id=any(p_ids) and status='open';
  get diagnostics n=row_count;
 elsif p_decision='set_aside' then
  update fin_review_item set status='set_aside',decided_by=current_viewer(),decided_at=now() where id=any(p_ids) and status='open';
  get diagnostics n=row_count;
 else
  update fin_review_item set status='open',decided_by=null,decided_at=null,decided_category=null where id=any(p_ids) and status='set_aside';
  get diagnostics n=row_count;
 end if;
 perform audit_write('import','finance.agent_review',p_decision,array['lines']);
 return jsonb_build_object('changed',n,'saved',saved);
end $$;
create function pulse.agent_skill_publish(p_skill uuid, p_publish boolean) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare s agent_skill; v agent_skill_version;
begin
 if not skill_can_publish() then raise exception 'Only leadership with the Money plan permission, or an admin, publishes a skill' using errcode='42501'; end if;
 select * into s from agent_skill where id=p_skill and org_id=current_org() for update;
 if not found then raise exception 'No such skill' using errcode='22023'; end if;
 if not p_publish then
  update agent_skill set status='retired',retired_by=current_viewer(),retired_at=now() where id=s.id;
  return jsonb_build_object('status','retired');
 end if;
 select * into v from agent_skill_version where skill_id=s.id and version=s.version;
 if coalesce((v.test_result->>'passed')::int,0)<1 or coalesce((v.test_result->>'failed')::int,1)<>0 then
  raise exception 'Its tests have to pass before it is used: this version has not passed them' using errcode='22023'; end if;
 update agent_skill set status='published',published_version=s.version,published_by=current_viewer(),published_at=now(),retired_by=null,retired_at=null where id=s.id;
 return jsonb_build_object('status','published','version',s.version);
end $$;

revoke all on function pulse.fin_agent_reads(uuid),pulse.skill_can_publish(),pulse.agent_job_allowed(uuid,text),pulse.agent_job_words(pulse.agent_job),pulse.agent_job_tell(uuid),
 pulse.agent_job_create(text,text,uuid,uuid,jsonb,uuid[],uuid),pulse.fin_agent_job_start(uuid,text,jsonb),pulse.fin_agent_job_part(uuid,int,int,bytea),pulse.agent_job_claim(text[]),
 pulse.agent_job_mine(uuid,uuid),pulse.agent_job_bytes(uuid,uuid,int,int),pulse.agent_job_context(uuid,uuid),pulse.agent_job_progress(uuid,uuid,int,text),
 pulse.agent_job_items(uuid,uuid,jsonb),pulse.agent_skill_propose(uuid,uuid,jsonb),pulse.agent_job_finish(uuid,uuid,text,text,jsonb,text,jsonb),pulse.agent_job_model_use(uuid,uuid,int),
 pulse.fin_review_decide(uuid[],text,text),pulse.agent_skill_publish(uuid,boolean) from public;
grant execute on function pulse.fin_agent_reads(uuid),pulse.skill_can_publish(),pulse.agent_job_allowed(uuid,text),pulse.agent_job_words(pulse.agent_job),
 pulse.agent_job_create(text,text,uuid,uuid,jsonb,uuid[],uuid),pulse.fin_agent_job_start(uuid,text,jsonb),pulse.fin_agent_job_part(uuid,int,int,bytea),pulse.agent_job_claim(text[]),
 pulse.agent_job_bytes(uuid,uuid,int,int),pulse.agent_job_context(uuid,uuid),pulse.agent_job_progress(uuid,uuid,int,text),
 pulse.agent_job_items(uuid,uuid,jsonb),pulse.agent_skill_propose(uuid,uuid,jsonb),pulse.agent_job_finish(uuid,uuid,text,text,jsonb,text,jsonb),pulse.agent_job_model_use(uuid,uuid,int),
 pulse.fin_review_decide(uuid[],text,text),pulse.agent_skill_publish(uuid,boolean) to pulse_api;

-- migrate:down
drop function if exists pulse.agent_skill_publish(uuid,boolean),pulse.fin_review_decide(uuid[],text,text),pulse.agent_job_model_use(uuid,uuid,int),
 pulse.agent_job_finish(uuid,uuid,text,text,jsonb,text,jsonb),pulse.agent_skill_propose(uuid,uuid,jsonb),pulse.agent_job_items(uuid,uuid,jsonb),pulse.agent_job_progress(uuid,uuid,int,text),
 pulse.agent_job_context(uuid,uuid),pulse.agent_job_bytes(uuid,uuid,int,int),pulse.agent_job_mine(uuid,uuid),pulse.agent_job_claim(text[]),pulse.fin_agent_job_part(uuid,int,int,bytea),
 pulse.fin_agent_job_start(uuid,text,jsonb),pulse.agent_job_create(text,text,uuid,uuid,jsonb,uuid[],uuid),pulse.agent_job_tell(uuid),pulse.agent_job_words(pulse.agent_job),
 pulse.agent_job_allowed(uuid,text);
drop table if exists pulse.fin_review_item,pulse.agent_skill_version,pulse.agent_skill,pulse.agent_job_part,pulse.agent_job_file,pulse.agent_job;
drop function if exists pulse.skill_can_publish(),pulse.fin_agent_reads(uuid);
