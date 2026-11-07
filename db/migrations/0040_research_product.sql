-- migrate:up
-- Clean observations retain their source window. No source hypothesis is a confirmed identity or cash payment.
alter table pulse.lead alter column created_at drop not null;
alter table pulse.lead add column kind text not null default 'buyer' check(kind in ('buyer','ea_own_funnel','hiring'));
alter table pulse.lead add column research_key text;
alter table pulse.lead add column locked text[] not null default '{}';
create table pulse.research_engagement (
 org_id uuid not null references pulse.org(id), folder_id text not null, project_id uuid references pulse.project(id),
 project_key text not null, client_key text, segment text not null, locality text, month date, flags text[],
 primary key(org_id,folder_id)
);
create table pulse.lead_answer (
 org_id uuid not null references pulse.org(id), lead_id uuid primary key references pulse.lead(id),
 project_key text, platform text, creative_type text not null, creative_no text, language text,
 budget_lakh numeric, visit_intent text, bhk text, sheet_ref text not null, source_ref text not null,
 locked text[] not null default '{}', unique(org_id,source_ref)
);
create table pulse.lead_touch (
 org_id uuid not null references pulse.org(id), lead_id uuid primary key references pulse.lead(id),
 touches int not null check(touches>=0), outcome text check(outcome in ('booked','visit_done','visit_planned','interested','location_mismatch','budget_mismatch','not_interested','already_bought','broker','invalid','unreachable')),
 manual boolean not null default false, changed_by uuid references pulse.person(id), changed_at timestamptz,
 source text not null default 'sheet_snapshot'
);
create table pulse.research_import (
 org_id uuid not null references pulse.org(id), dataset text not null, sha256 text not null,
 row_count int not null, source_as_of date not null, imported_at timestamptz not null default now(),
 primary key(org_id,dataset)
);
create table pulse.research_notice (
 org_id uuid not null references pulse.org(id), source_key text not null, day date not null,
 kind text not null, occurrences int not null check(occurrences>0), account_ref text, project_key text,
 primary key(org_id,source_key)
);
create table pulse.research_month (
 org_id uuid not null references pulse.org(id), month date not null, kind text not null, n int not null,
 primary key(org_id,month,kind)
);
create table pulse_priv.ad_account (
 org_id uuid not null references pulse.org(id), account_id text not null, name text not null,
 project_key text, client_id uuid references pulse.client(id), project_id uuid references pulse.project(id),
 match_method text, confidence numeric, manual boolean not null default false,
 mapped_by uuid references pulse.person(id), mapped_at timestamptz,
 primary key(org_id,account_id)
);
create table pulse_priv.ad_funding (
 org_id uuid not null references pulse.org(id), txn_key text not null, account_id text not null,
 kind text not null check(kind in ('funds','billed')), day date not null, amount numeric not null check(amount>=0),
 currency text not null check(currency ~ '^[A-Z]{3}$'), source_ref text not null,
 primary key(org_id,txn_key), foreign key(org_id,account_id) references pulse_priv.ad_account(org_id,account_id)
);
create index research_lead_kind_time on pulse.lead(org_id,kind,created_at);
create index research_answer_project on pulse.lead_answer(org_id,project_key);
create index research_funding_day on pulse_priv.ad_funding(org_id,day);
create index research_funding_account on pulse_priv.ad_funding(org_id,account_id,day);
create index research_engagement_project on pulse.research_engagement(org_id,project_id);
create index research_engagement_key on pulse.research_engagement(org_id,project_key);
do $$ declare t text; begin
 foreach t in array array['pulse.research_engagement','pulse.lead_answer','pulse.lead_touch','pulse.research_import','pulse.research_notice','pulse.research_month','pulse_priv.ad_account','pulse_priv.ad_funding'] loop
 execute format('alter table %s enable row level security',t);
 execute format('alter table %s force row level security',t);
 execute format('create policy tenant_isolation on %s using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
 execute format('grant select,insert,update,delete on %s to pulse_worker',t);
 execute format('grant select on %s to pulse_api',t);
 end loop;
end $$;
-- Money has a database backstop as well as HTTP checks. Buyer hashes are never granted to the API.
create policy ad_money on pulse_priv.ad_account as restrictive to pulse_api using(pulse.money_can('money.read') and pulse.money_can('money.amount.read'));
create policy ad_money on pulse_priv.ad_funding as restrictive to pulse_api using(pulse.money_can('money.read') and pulse.money_can('money.amount.read'));
grant update on pulse_priv.ad_account to pulse_api;
create policy ad_mapping_write on pulse_priv.ad_account as restrictive for update to pulse_api using(pulse.money_can('money.plan.write')) with check(pulse.money_can('money.plan.write'));
-- Only designated project leads/managers can record operational call observations; company leaders can correct them.
grant update on pulse.lead_touch to pulse_api;
create policy touch_write on pulse.lead_touch as restrictive for update to pulse_api
 using(pulse.viewer_is('admin','leadership') or exists(select 1 from pulse.lead l join pulse.project p on p.id=l.project_id where l.id=lead_id and (p.lead_person_id=pulse.current_viewer() or p.id=any(pulse.work_projects()))))
 with check(pulse.viewer_is('admin','leadership') or exists(select 1 from pulse.lead l join pulse.project p on p.id=l.project_id where l.id=lead_id and (p.lead_person_id=pulse.current_viewer() or p.id=any(pulse.work_projects()))));
create trigger audit_mutation after update on pulse_priv.ad_account for each row execute function pulse.audit_mutation();
create trigger audit_mutation after update on pulse.lead_touch for each row execute function pulse.audit_mutation();
-- migrate:down
