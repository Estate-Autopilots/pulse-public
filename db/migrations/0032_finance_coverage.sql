-- migrate:up
create table pulse_priv.cash_balance (
 org_id uuid not null references pulse.org(id),currency text not null check(currency~'^[A-Z]{3}$'),amount numeric not null check(amount>=0),as_of date not null,
 history_reconciled boolean not null default false,edited_by uuid references pulse.person(id),updated_at timestamptz not null default now(),primary key(org_id,currency)
);
alter table pulse_priv.cash_balance enable row level security;
alter table pulse_priv.cash_balance force row level security;
create policy tenant on pulse_priv.cash_balance using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
grant select,insert,update,delete on pulse_priv.cash_balance to pulse_worker;
create trigger audit_mutation after insert or update or delete on pulse_priv.cash_balance for each row execute function pulse.audit_mutation();
create function pulse.money_cash_balance(p_currency text,p_amount numeric,p_as_of date,p_complete boolean) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not money_can('money.plan.write') or not money_can('money.amount.read') then raise exception 'denied' using errcode='42501';end if;
 if p_amount<0 or p_amount>1e14 or p_as_of>current_date then raise exception 'invalid cash balance' using errcode='22023';end if;
 insert into pulse_priv.cash_balance(org_id,currency,amount,as_of,history_reconciled,edited_by) values(current_org(),p_currency,p_amount,p_as_of,p_complete,current_viewer())
 on conflict(org_id,currency) do update set amount=excluded.amount,as_of=excluded.as_of,history_reconciled=excluded.history_reconciled,edited_by=excluded.edited_by,updated_at=now();
end $$;
create function pulse.money_cash_balances() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not money_can('money.read') or not money_can('money.amount.read') then raise exception 'denied' using errcode='42501';end if;
 perform audit_write('restricted_read','money.cash_balance');
 return coalesce((select jsonb_agg(to_jsonb(b)) from pulse_priv.cash_balance b),'[]');
end $$;
create function pulse.payroll_cost_trend() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not hr_can('hr.salary.read') then raise exception 'denied' using errcode='42501';end if;
 perform audit_write('restricted_read','hr.payroll_trend');
 return coalesce((select jsonb_agg(to_jsonb(t) order by t."month") from (
 select effective_month "month",currency,sum(amount) amount,count(*) people from (
 select distinct on(c.person_id,c.effective_month) c.person_id,c.effective_month,c.currency,c.amount from pulse_priv.hr_compensation c
 where c.kind in ('monthly','current') order by c.person_id,c.effective_month,(c.kind='monthly') desc,c.imported_at desc,c.id
 ) rates group by effective_month,currency) t),'[]');
end $$;
revoke all on function pulse.money_cash_balance(text,numeric,date,boolean),pulse.money_cash_balances(),pulse.payroll_cost_trend() from public;
grant execute on function pulse.money_cash_balance(text,numeric,date,boolean),pulse.money_cash_balances(),pulse.payroll_cost_trend() to pulse_api;
-- migrate:down
