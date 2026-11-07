-- migrate:up
-- TWO-STEP-GUIDE: the guided two-step window asks once the organisation's grace period has ended, as the rule itself
-- says (a new company's admins are not interrupted in their first 14 days; Atlas Crest' grace ended on 29 Oct).
-- Until then Account / Security offers the same steps.
create or replace function pulse.auth_two_step_due(a uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists (select 1 from pulse_priv.auth_policy where org_id = current_org() and required and grace_until < now() and a is distinct from exempt_owner)
     and exists (select 1 from role_assignment where org_id = current_org() and person_id = a and role_key in ('admin', 'hr', 'leadership')
                  and current_date between valid_from and coalesce(valid_to, 'infinity'))
     and exists (select 1 from login_credential where org_id = current_org() and person_id = a and status = 'active')
     and not exists (select 1 from pulse_priv.auth_account where org_id = current_org() and realm = 'staff' and actor = a and totp is not null)
$$;

-- migrate:down
create or replace function pulse.auth_two_step_due(a uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists (select 1 from pulse_priv.auth_policy where org_id = current_org() and required and a is distinct from exempt_owner)
     and exists (select 1 from role_assignment where org_id = current_org() and person_id = a and role_key in ('admin', 'hr', 'leadership')
                  and current_date between valid_from and coalesce(valid_to, 'infinity'))
     and exists (select 1 from login_credential where org_id = current_org() and person_id = a and status = 'active')
     and not exists (select 1 from pulse_priv.auth_account where org_id = current_org() and realm = 'staff' and actor = a and totp is not null)
$$;
