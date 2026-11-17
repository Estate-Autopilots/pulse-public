-- migrate:up
-- Seed a default personal allowance without replacing any tenant's configured leave types.
create or replace function pulse.hr_defaults() returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if pulse.current_org() is null then return; end if;
  insert into hr_policy(org_id, wfh_per_month) values (pulse.current_org(), 2) on conflict do nothing;
  insert into leave_type(org_id, key, name, paid, annual_days, accrual, carry_forward_max, sort) values
    (pulse.current_org(), 'annual', 'Paid leave', true, 12, 'monthly', 6, 1),
    (pulse.current_org(), 'sick', 'Sick leave', true, 6, 'yearly', 0, 2),
    (pulse.current_org(), 'personal', 'Personal leave', true, 2, 'yearly', 0, 3),
    (pulse.current_org(), 'unpaid', 'Unpaid leave', false, null, 'none', 0, 4)
    on conflict do nothing;
end $$;

-- Existing organisations with an HR policy have already run hr_defaults; add only the new key for them.
insert into pulse.leave_type(org_id, key, name, paid, annual_days, accrual, carry_forward_max, sort)
select org_id, 'personal', 'Personal leave', true, 2, 'yearly', 0, 3
from pulse.hr_policy
on conflict do nothing;

-- migrate:down
-- Forward-only: retain configured leave types once tenants have used them.
