-- migrate:up
-- FIN-ENTRY (owner, 22 Oct 2026: "Finance does not have a way of adding anything."). Plain entry next to the imported
-- observations (sheets, Drive bills, bank lines):
--  * pulse.fin_entry: an expense, income / payment received, bill, refund or transfer typed in Pulse (form, one-line quick
--    add, /expense in Chats, or a confirmed WhatsApp payment screenshot). Amounts are integer paise. Never hard-deleted:
--    delete sets deleted_at with a reason; every change lands in pulse.fin_entry_event (before / after, who, when).
--  * Approval: an entry above the company's limit (pulse.fin_entry_settings.approval_minor, ₹50,000 to start) by someone
--    who is not leadership waits as "pending" until leadership approves it; only approved entries count in the totals.
--    The rule lives in the trigger, so no caller can skip it.
--  * pulse.fin_entry_file: the receipt / screenshot (photo or PDF, up to 8 MB), bytes kept in the database.
--  * pulse.fin_wa_screen: payment screenshots found in the WhatsApp index (ea_index wa.payment_screens, read-only there),
--    copied with a small thumbnail by the finance worker (python -m pulse_workers.finance_live wa-screens). Pulse never
--    writes to ea_index. pulse.fin_wa_decision keeps what Finance did with each one (confirmed as an entry / not money).
-- Who: leadership (the finance amount grants) and the Finance role write; an Accountant does not see hand entries.

create function pulse.fin_entry_can(p_write boolean default false) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and not is_accountant(current_viewer()) and (viewer_is('finance')
  or (money_can('money.read') and money_can('money.amount.read') and (not p_write or money_can('money.plan.write'))))
$$;
-- Approves entries above the limit and changes the limit, the categories and the accounts.
create function pulse.fin_entry_approver() returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and money_can('money.plan.write')
$$;

create table pulse.fin_entry_settings (
 org_id uuid primary key references pulse.org(id),
 approval_minor bigint not null default 5000000 check(approval_minor between 0 and 9000000000000),
 categories text[] not null default array['Ad spend','Software & tools','Rent & office','Salaries','Travel','Food & office supplies',
  'Utilities','Professional fees','Equipment','Taxes & GST','Bank charges','Client payment','Other income','Other']
  check(cardinality(categories) between 1 and 80),
 accounts text[] not null default array['HDFC current','ICICI current','Company card','Cash','UPI']
  check(cardinality(accounts) between 1 and 40),
 updated_by uuid references pulse.person(id),updated_at timestamptz not null default now()
);

create table pulse.fin_entry (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 kind text not null check(kind in ('expense','income','bill','refund','transfer')),
 -- Money in (income, a refund received), money out (expense, bill, a refund paid) or between own accounts.
 direction text not null check(direction in ('in','out','neutral')),
 entry_date date not null check(entry_date between date '2000-01-01' and date '2100-01-01'),
 amount_minor bigint not null check(amount_minor between 1 and 9000000000000),
 gst_minor bigint not null default 0 check(gst_minor>=0 and gst_minor<=amount_minor),
 currency text not null default 'INR' check(currency ~ '^[A-Z]{3}$'),
 category text check(length(category)<=60),
 account_from text check(length(account_from)<=80),
 account_to text check(length(account_to)<=80),
 client_id uuid references pulse.client(id),
 project_id uuid references pulse.project(id),
 vendor text check(length(vendor)<=120),
 note text check(length(note)<=1000),
 bill_status text check(bill_status in ('unpaid','paid')),
 due_date date,
 status text not null default 'approved' check(status in ('approved','pending','rejected')),
 decided_by uuid references pulse.person(id),decided_at timestamptz,decision_note text check(length(decision_note)<=300),
 source text not null default 'manual' check(source in ('manual','quick','whatsapp','chat')),
 source_ref text check(length(source_ref)<=200),
 quick_text text check(length(quick_text)<=300),
 created_by uuid references pulse.person(id),created_at timestamptz not null default now(),
 updated_by uuid references pulse.person(id),updated_at timestamptz not null default now(),
 deleted_at timestamptz,deleted_by uuid references pulse.person(id),delete_reason text check(length(delete_reason)<=300),
 check(kind<>'transfer' or direction='neutral'),
 check(kind not in ('expense','bill') or direction='out'),
 check(kind<>'income' or direction='in'),
 check(kind<>'refund' or direction in ('in','out'))
);
create index fin_entry_date on pulse.fin_entry(org_id,entry_date desc) where deleted_at is null;
create unique index fin_entry_wa on pulse.fin_entry(org_id,source_ref) where source='whatsapp' and deleted_at is null;

create table pulse.fin_entry_file (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 entry_id uuid references pulse.fin_entry(id),
 name text not null check(length(name) between 1 and 200),
 mime text not null check(mime in ('image/jpeg','image/png','image/webp','application/pdf')),
 size int not null check(size between 1 and 8388608),
 sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
 bytes bytea not null,
 created_by uuid references pulse.person(id),created_at timestamptz not null default now(),
 removed_at timestamptz
);
create index fin_entry_file_entry on pulse.fin_entry_file(org_id,entry_id);

create table pulse.fin_entry_event (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 entry_id uuid not null references pulse.fin_entry(id),
 action text not null check(action in ('created','edited','approved','rejected','sent_for_approval','deleted','restored')),
 before jsonb,after jsonb,
 actor uuid references pulse.person(id),at timestamptz not null default now()
);
create index fin_entry_event_entry on pulse.fin_entry_event(org_id,entry_id,at);

create table pulse.fin_wa_screen (
 org_id uuid not null references pulse.org(id),
 sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
 amount numeric(16,2),amounts numeric(16,2)[] not null default '{}',
 transaction_ids text[] not null default '{}',dates_in_text text[] not null default '{}',
 payee text check(length(payee)<=200),
 sent_at timestamptz,sender text check(length(sender)<=120),sender_role text check(length(sender_role)<=40),
 message_text text check(length(message_text)<=600),
 group_title text check(length(group_title)<=300),client_hint text check(length(client_hint)<=200),
 drive_file_id text check(length(drive_file_id)<=200),
 thumb bytea check(octet_length(thumb)<=600000),thumb_mime text check(thumb_mime in ('image/jpeg','image/png','image/webp')),
 synced_at timestamptz not null default now(),
 primary key(org_id,sha256)
);
create table pulse.fin_wa_decision (
 org_id uuid not null references pulse.org(id),
 sha256 text not null,
 decision text not null check(decision in ('confirmed','dismissed')),
 entry_id uuid references pulse.fin_entry(id),
 actor uuid references pulse.person(id),at timestamptz not null default now(),
 primary key(org_id,sha256)
);

do $$ declare t text;begin
 foreach t in array array['fin_entry_settings','fin_entry','fin_entry_file','fin_entry_event','fin_wa_screen','fin_wa_decision'] loop
  execute format('alter table pulse.%I enable row level security',t);
  execute format('alter table pulse.%I force row level security',t);
  execute format('create policy tenant_isolation on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
  execute format('create policy fin_read on pulse.%I as restrictive for select to pulse_api using(pulse.fin_entry_can(false))',t);
  execute format('create trigger audit_mutation after insert or update or delete on pulse.%I for each row execute function pulse.audit_mutation()',t);
 end loop;
 foreach t in array array['fin_entry','fin_entry_file','fin_wa_decision'] loop
  execute format('create policy fin_insert on pulse.%I as restrictive for insert to pulse_api with check(pulse.fin_entry_can(true))',t);
  execute format('create policy fin_update on pulse.%I as restrictive for update to pulse_api using(pulse.fin_entry_can(true)) with check(pulse.fin_entry_can(true))',t);
 end loop;
end $$;
create policy fin_insert on pulse.fin_entry_settings as restrictive for insert to pulse_api with check(pulse.fin_entry_approver());
create policy fin_update on pulse.fin_entry_settings as restrictive for update to pulse_api using(pulse.fin_entry_approver()) with check(pulse.fin_entry_approver());
grant select,insert,update on pulse.fin_entry,pulse.fin_entry_file,pulse.fin_entry_settings,pulse.fin_wa_decision to pulse_api;
grant select on pulse.fin_entry_event,pulse.fin_wa_screen to pulse_api;
-- Setting a screenshot aside can be undone; deleting its entry puts the screenshot back among the suggestions.
grant delete on pulse.fin_wa_decision to pulse_api;
create policy fin_delete on pulse.fin_wa_decision as restrictive for delete to pulse_api using(pulse.fin_entry_can(true));
grant select,insert,update,delete on pulse.fin_wa_screen to pulse_worker;
grant select on pulse.fin_wa_decision,pulse.fin_entry to pulse_worker;

-- The approval rule and the history, for every write whoever makes it.
create function pulse.fin_entry_guard() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare lim bigint;boss boolean:=fin_entry_approver();
begin
 select approval_minor into lim from fin_entry_settings where org_id=new.org_id;lim:=coalesce(lim,5000000);
 new.updated_at:=now();new.updated_by:=coalesce(current_viewer(),new.updated_by);
 if tg_op='INSERT' then
  new.created_by:=coalesce(current_viewer(),new.created_by);
  new.status:=case when new.amount_minor>lim and not boss then 'pending' else 'approved' end;
  new.decided_by:=case when new.status='approved' and boss then current_viewer() end;new.decided_at:=case when new.decided_by is not null then now() end;
  return new;
 end if;
 if old.deleted_at is not null and new.deleted_at is not null then raise exception 'This entry was deleted; restore it first' using errcode='22023';end if;
 if new.status is distinct from old.status then
  if not boss then raise exception 'Only leadership approves entries above the limit' using errcode='42501';end if;
  new.decided_by:=current_viewer();new.decided_at:=now();
 elsif (new.amount_minor,new.kind,new.direction) is distinct from (old.amount_minor,old.kind,old.direction) and new.amount_minor>lim and not boss then
  -- A change to an approved figure above the limit goes back for approval.
  new.status:='pending';new.decided_by:=null;new.decided_at:=null;
 end if;
 return new;
end $$;
create trigger fin_entry_guard before insert or update on pulse.fin_entry for each row execute function pulse.fin_entry_guard();

create function pulse.fin_entry_log() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a text;
begin
 a:=case when tg_op='INSERT' then 'created'
  when new.deleted_at is not null and old.deleted_at is null then 'deleted'
  when new.deleted_at is null and old.deleted_at is not null then 'restored'
  when new.status is distinct from old.status and new.status='approved' then 'approved'
  when new.status is distinct from old.status and new.status='rejected' then 'rejected'
  when new.status is distinct from old.status and new.status='pending' then 'sent_for_approval'
  else 'edited' end;
 insert into fin_entry_event(org_id,entry_id,action,before,after,actor)
 values(new.org_id,new.id,a,case when tg_op='UPDATE' then to_jsonb(old) end,to_jsonb(new),current_viewer());
 return null;
end $$;
create trigger fin_entry_log after insert or update on pulse.fin_entry for each row execute function pulse.fin_entry_log();

-- Opening the entries is a restricted read, logged like the other finance views.
create function pulse.fin_entry_open() returns boolean language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not fin_entry_can(false) then raise exception 'Finance entries are for leadership and the Finance role' using errcode='42501';end if;
 perform audit_write('restricted_read','finance.entries');
 return fin_entry_approver();
end $$;
revoke all on function pulse.fin_entry_can(boolean),pulse.fin_entry_approver(),pulse.fin_entry_open() from public;
grant execute on function pulse.fin_entry_can(boolean),pulse.fin_entry_approver(),pulse.fin_entry_open() to pulse_api,pulse_worker;

-- migrate:down
-- Forward-only.
