-- migrate:up
-- QUOTE-BUILDER (owner, 19-20 Nov 2026; board 5, option C "Quote + AI assistant"): your own price on any line, extra
-- charges, charges settled at the end (transport per km) and the AI's change card, in quotations, proformas and invoices.
--  1. erp_line.charge: an extra charge, kept under "Extra charges" apart from the items: 'fixed' (installation ₹12,000,
--     in the total like any line) or 'variable' (transport per km, loading: settled at the end). A variable charge is an
--     estimate until erp_line.confirmed: an estimate stays out of the document's total (taxable, GST, total) and is
--     shown apart as "to be confirmed"; erp_document.estimate keeps the estimates' sum with their GST. An invoice is not
--     issued while it has an estimate: each one is confirmed (its final amount) first.
--  2. erp_line.price_note: why a line is priced away from its base (catalogue_rate, 0506: the catalogue or rate-card
--     price when the line was added; the API now keeps it for every catalogue line). Base, difference and margin are
--     for the seller only: the customer's copy prints the price alone.
--  3. pulse.erp_quote_proposal: what the AI proposes for a draft (add a charge, change a price, ...). Nothing changes
--     until a person taps Apply (status applied) or Not now (dismissed). The tenant and ERP policies, grants and audit of
--     the other erp_ tables (0190, 0545).
-- Synthetic data only in tests; nothing here reads or writes a company's data.

alter table pulse.erp_line add column charge text check (charge is null or charge in ('fixed', 'variable'));
alter table pulse.erp_line add column confirmed boolean not null default false;
alter table pulse.erp_line add column price_note text check (price_note is null or (length(btrim(price_note)) between 1 and 160 and price_note !~ '[[:cntrl:]]'));
alter table pulse.erp_line add constraint erp_line_confirmed_variable check (not confirmed or charge is not distinct from 'variable');
alter table pulse.erp_line add constraint erp_line_charge_role check (charge is null or line_role is null);
comment on column pulse.erp_line.charge is 'QUOTE-BUILDER (2490): an extra charge: fixed (in the total) or variable (settled at the end; an estimate until confirmed)';
comment on column pulse.erp_line.confirmed is 'QUOTE-BUILDER (2490): a variable charge whose final amount is set (it then counts in the total)';
comment on column pulse.erp_line.price_note is 'QUOTE-BUILDER (2490): why the line is priced away from its base (catalogue_rate); never printed';

alter table pulse.erp_document add column estimate bigint not null default 0 check (estimate >= 0);
comment on column pulse.erp_document.estimate is 'QUOTE-BUILDER (2490): the variable charges still to be confirmed, with their GST (not in total)';

-- An invoice is issued only once every variable charge on it is confirmed.
create function pulse.erp_estimates_settled() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if new.doc_type = 'invoice' and old.status = 'draft' and new.status not in ('draft', 'cancelled')
     and exists(select 1 from erp_line l where l.document_id = new.id and l.charge = 'variable' and not l.confirmed and not l.not_needed) then
    raise exception 'Confirm each charge that was an estimate before the invoice is issued' using errcode = '22023';
  end if;
  return new;
end $$;
revoke all on function pulse.erp_estimates_settled() from public;
create trigger erp_estimates_settled before update of status on pulse.erp_document for each row execute function pulse.erp_estimates_settled();

create table pulse.erp_quote_proposal (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references pulse.org(id),
  document_id uuid not null references pulse.erp_document(id) on delete cascade,
  changes     jsonb not null check (jsonb_typeof(changes) = 'array' and jsonb_array_length(changes) between 1 and 20 and pg_column_size(changes) < 16384),
  ask         text check (ask is null or length(ask) <= 500),
  status      text not null default 'pending' check (status in ('pending', 'applied', 'dismissed')),
  before_total bigint not null check (before_total >= 0),
  after_total  bigint not null check (after_total >= 0),
  created_by  uuid references pulse.person(id),
  created_at  timestamptz not null default now(),
  decided_by  uuid references pulse.person(id),
  decided_at  timestamptz,
  check ((status = 'pending') = (decided_at is null))
);
create index erp_quote_proposal_doc on pulse.erp_quote_proposal (org_id, document_id, created_at desc) where status = 'pending';
comment on table pulse.erp_quote_proposal is 'QUOTE-BUILDER (2490): an AI change card for a draft; nothing changes until a person applies it';
alter table pulse.erp_quote_proposal enable row level security;
alter table pulse.erp_quote_proposal force row level security;
create policy tenant on pulse.erp_quote_proposal using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy erp_read on pulse.erp_quote_proposal as restrictive for select to pulse_api using ((select pulse.erp_can(false)));
create policy erp_insert on pulse.erp_quote_proposal as restrictive for insert to pulse_api with check ((select pulse.erp_can(true)));
create policy erp_update on pulse.erp_quote_proposal as restrictive for update to pulse_api using ((select pulse.erp_can(true))) with check ((select pulse.erp_can(true)));
create policy erp_delete on pulse.erp_quote_proposal as restrictive for delete to pulse_api using ((select pulse.erp_can(true)));
create trigger audit_mutation after insert or update or delete on pulse.erp_quote_proposal for each row execute function pulse.audit_mutation();
grant select, insert, update, delete on pulse.erp_quote_proposal to pulse_api;

-- migrate:down
-- Forward-only: charges, notes, estimates and proposals are kept.
