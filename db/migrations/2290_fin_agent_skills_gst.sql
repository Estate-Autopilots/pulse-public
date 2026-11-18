-- migrate:up
-- FIN-AGENT-2 (18 Nov 2026), after FIN-AGENT's 2240 (jobs, skills, review lines):
--  * The AI step for lines no rule knows: a job may make one model call for its unclear groups when the AI employee's
--    budget is not used up (agent_job_context.modelOk). Its guesses stay "to check"; when a person confirms a guess as it
--    was, that counts as two agreeing decisions (the AI's and the person's), so the next statement learns the rule.
--  * Learned skills as tools (API v1 / MCP): the company's published skills, listed and run by an AI employee or a
--    person with Finance (agent_skill_catalog, agent_skill_take, agent_skill_count), and a job that runs one named skill
--    on a chat's files (kind fin.skill: agent_job_context hands it that skill).
--  * GST reconciliation (kind fin.gst, or GST returns sent with statements): the context carries each invoice's GST
--    split and the buyer's GSTIN, and the bank payments people and jobs already have, to match GSTR-1, GSTR-3B and
--    GSTR-2B against Pulse.
-- Nothing here moves money or changes a finance record; confirming stays a person's act (fin_review_decide).

create or replace function pulse.agent_job_context(p_job uuid, p_lease uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare j agent_job:=agent_job_mine(p_job,p_lease); inv jsonb:='[]'; pay jsonb:='[]'; model_ok boolean:=true; sk jsonb:=null;
begin
 begin
  select coalesce(jsonb_agg(jsonb_build_object('no',d.number,'amount',d.total,'gst',d.cgst+d.sgst+d.igst,'date',d.issue_date,'client',coalesce(c.name,d.buyer->>'name'),
    'taxable',d.taxable,'cgst',d.cgst,'sgst',d.sgst,'igst',d.igst,'gstin',nullif(btrim(d.buyer->>'gstin'),''),'status',d.status)),'[]') into inv
   from erp_document d left join client c on c.id=d.client_id
   where d.org_id=current_org() and d.doc_type='invoice' and d.status in ('issued','sent','part_paid','paid') and d.issue_date>current_date-800 limit 5000;
 exception when others then inv:='[]';
 end;
 -- GST work matches purchases to the bank payments Pulse already holds (lines from earlier jobs, any decision but set aside).
 if j.kind='fin.gst' or coalesce(j.input->>'gst','')='true' then
  select coalesce(jsonb_agg(jsonb_build_object('date',i.txn_date,'amount',i.amount_minor,'who',i.counterparty,'category',coalesce(i.decided_category,i.category),'narration',i.narration)),'[]') into pay
   from (select * from fin_review_item where org_id=current_org() and direction='out' and status<>'set_aside' and txn_date>current_date-800 order by txn_date desc limit 20000) i;
 end if;
 -- One model call a job at most, and none once its token budget is used up.
 begin
  model_ok:=coalesce(agent_budget_state(j.agent_id)->>'level','ok')<>'out';
 exception when others then model_ok:=false;
 end;
 if j.kind='fin.skill' then
  select jsonb_build_object('id',s.id,'name',s.name,'kind',s.kind,'status',s.status,'version',v.version,'body',v.body,'tests',v.tests) into sk
   from agent_skill s join agent_skill_version v on v.skill_id=s.id and v.version=s.published_version
   where s.org_id=current_org() and s.status='published' and s.name=j.input->>'skill';
 end if;
 return jsonb_build_object(
  'kind',j.kind,'input',j.input,'modelOk',model_ok,'skill',sk,
  'skills',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'kind',s.kind,'status',s.status,'version',v.version,'body',v.body,'tests',v.tests)),'[]')
    from agent_skill s join agent_skill_version v on v.skill_id=s.id and v.version=case when s.status='published' then s.published_version else s.version end
    where s.org_id=current_org() and s.status<>'retired' and (s.status='published' or s.agent_id=j.agent_id)),
  'invoices',inv,
  'payments',pay,
  -- The company's own GSTIN (its seller details on its invoices and quotations), to tell its own returns apart.
  'gstin',(select nullif(btrim(d.seller->>'gstin'),'') from erp_document d where d.org_id=current_org() and nullif(btrim(d.seller->>'gstin'),'') is not null order by d.created_at desc limit 1),
  'largeMinor',coalesce((select approval_minor from fin_entry_settings where org_id=current_org()),5000000),
  -- What people decided before; "agreed" counts the lines where a person kept the AI's guess as it was.
  'decisions',(select coalesce(jsonb_agg(x),'[]') from (select lower(counterparty) who,direction,coalesce(decided_category,category) category,count(*) n,
    count(*) filter (where source like 'ai:%' and decided_category=category) agreed
    from fin_review_item where org_id=current_org() and status='confirmed' and counterparty is not null group by 1,2,3 order by n desc limit 500) x));
end $$;

-- Who may use the company's learned skills as tools: an AI employee of this company (its own session), or a person
-- who reads Finance (as Finance → Entries) or an admin. Only published skills are tools.
create function pulse.agent_skill_tool_ok() returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select case when agent_session() is not null then true else current_viewer() is not null and (fin_entry_can(false) or viewer_is('admin')) end
$$;

create function pulse.agent_skill_catalog(p_area text) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
begin
 if not agent_skill_tool_ok() then raise exception 'The company''s learned skills are for its AI employees and the people who read Finance' using errcode='42501'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('name',s.name,'title',s.title,'kind',s.kind,'area',s.area,'version',s.published_version,
   'uses',s.uses,'linesHandled',s.lines_handled,'modelCallsSaved',s.model_calls_saved,'lastUsedAt',s.last_used_at,'why',v.why,
   'rules',case when s.kind in ('categoriser','rule') then jsonb_array_length(coalesce(v.body->'rules','[]')) end,
   'bank',v.body->>'bank','columns',v.body->'signature','learnedBy',(select display_name from person where id=s.agent_id),'publishedAt',s.published_at)
   order by s.uses desc,s.name),'[]')
  from agent_skill s join agent_skill_version v on v.skill_id=s.id and v.version=s.published_version
  where s.org_id=current_org() and s.status='published' and (p_area is null or s.area=p_area));
end $$;

-- One published skill's body, to run it (a categoriser's rules are data; a parser runs in a job's sandbox).
create function pulse.agent_skill_take(p_name text) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare r jsonb;
begin
 if not agent_skill_tool_ok() then raise exception 'The company''s learned skills are for its AI employees and the people who read Finance' using errcode='42501'; end if;
 select jsonb_build_object('id',s.id,'name',s.name,'title',s.title,'kind',s.kind,'area',s.area,'version',s.published_version,'body',v.body) into r
  from agent_skill s join agent_skill_version v on v.skill_id=s.id and v.version=s.published_version
  where s.org_id=current_org() and s.status='published' and s.name=p_name;
 if r is null then raise exception 'No published skill by that name: list_skills shows them' using errcode='22023'; end if;
 return r;
end $$;

-- A skill run outside a job (a tool call): one more use, the lines it handled, one model call saved.
create function pulse.agent_skill_count(p_name text, p_lines int) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not agent_skill_tool_ok() then raise exception 'The company''s learned skills are for its AI employees and the people who read Finance' using errcode='42501'; end if;
 if coalesce(p_lines,0)<1 then return; end if;
 update agent_skill set uses=uses+1,lines_handled=lines_handled+least(p_lines,100000),model_calls_saved=model_calls_saved+1,last_used_at=now()
  where org_id=current_org() and name=p_name and status='published';
end $$;

revoke all on function pulse.agent_skill_tool_ok(),pulse.agent_skill_catalog(text),pulse.agent_skill_take(text),pulse.agent_skill_count(text,int) from public;
grant execute on function pulse.agent_skill_tool_ok(),pulse.agent_skill_catalog(text),pulse.agent_skill_take(text),pulse.agent_skill_count(text,int) to pulse_api;

-- migrate:down
drop function if exists pulse.agent_skill_count(text,int);
drop function if exists pulse.agent_skill_take(text);
drop function if exists pulse.agent_skill_catalog(text);
drop function if exists pulse.agent_skill_tool_ok();
