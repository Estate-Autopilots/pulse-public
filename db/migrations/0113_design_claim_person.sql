-- migrate:up
-- Expose only the claimant for confirmed design claims, independent of viewer RLS.
-- Pending and rejected claim details remain protected by delivery_claim_visible.
create function pulse.design_claim_person(p_file text) returns uuid
  language sql stable security definer set search_path=pulse,pg_temp as $$
    select claim.person_id
    from pulse.delivery_claim claim
    where claim.org_id=pulse.current_org() and claim.file_id=p_file
      and claim.claim_scope='design' and claim.status='confirmed'
    limit 1
  $$;
revoke all on function pulse.design_claim_person(text) from public;
grant execute on function pulse.design_claim_person(text) to pulse_api;

-- migrate:down
-- Forward-only: confirmed claims are attribution evidence and must remain auditable.
