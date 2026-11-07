-- migrate:up
-- KAZUK-FLOW G5 + G10 (Kazuk, 6 Nov 2026).
--  G5  One Send for both channels: the page e-mails the PDF (BILLING-EMAIL) and opens the customer's WhatsApp with its
--      link; each channel is one log line with the time and the version (erp_event 'emailed' and 'whatsapp_sent').
--      Nothing new in the database beyond the log's kinds (free text, 1..40 characters).
--  G10 "Payment received": amount, date, mode (UPI, NEFT, cheque…), the UTR or reference, and a proof (a screenshot or
--      PDF of the transfer). The proof is kept as uploaded, once, beside its payment (pulse.erp_payment_file), read by
--      whoever reads the payment (a salesperson their own deals', 1670). The sales flow's payment step says whether a
--      reference and a proof are required (payment.proofRequired; EA's preset: yes); the API holds it.
-- Synthetic data only in tests; nothing here reads or writes production data.

create table pulse.erp_payment_file (
  org_id uuid not null references pulse.org(id),
  payment_id uuid primary key references pulse.erp_payment(id),
  document_id uuid not null references pulse.erp_document(id),
  mime text not null check (mime in ('image/png', 'image/jpeg', 'application/pdf')),
  name text not null default '' check (length(name) <= 160),
  bytes bytea not null check (octet_length(bytes) between 1 and 5242880),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid references pulse.person(id),
  created_at timestamptz not null default now()
);
create index erp_payment_file_document on pulse.erp_payment_file(org_id, document_id);
alter table pulse.erp_payment_file enable row level security;
alter table pulse.erp_payment_file force row level security;
create policy tenant on pulse.erp_payment_file using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy erp_read on pulse.erp_payment_file as restrictive for select to pulse_api using ((select pulse.erp_can(false)));
create policy erp_insert on pulse.erp_payment_file as restrictive for insert to pulse_api with check ((select pulse.erp_can(true)));
create policy erp_own on pulse.erp_payment_file as restrictive for all to pulse_api
  using (not (select pulse.erp_own_only()) or pulse.erp_doc_mine(document_id)) with check (not (select pulse.erp_own_only()) or pulse.erp_doc_mine(document_id));
grant select, insert on pulse.erp_payment_file to pulse_api;
create trigger erp_own_guard before insert or update or delete on pulse.erp_payment_file for each row execute function pulse.erp_own_guard();
-- Its payment's document, never another's.
create function pulse.erp_payment_file_check() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if not exists(select 1 from erp_payment p where p.org_id = new.org_id and p.id = new.payment_id and p.document_id = new.document_id) then
    raise exception 'The proof belongs to a payment of this invoice' using errcode = '22023'; end if;
  return new;
end $$;
revoke all on function pulse.erp_payment_file_check() from public;
create trigger erp_payment_file_check before insert on pulse.erp_payment_file for each row execute function pulse.erp_payment_file_check();

-- EA's preset: a payment the salesperson records carries its reference (UTR) and its proof.
create or replace function pulse.erp_flow_preset(p_preset text) returns jsonb language sql immutable as $$
 select case p_preset
  when 'ea' then pulse.erp_flow_defaults() || jsonb_build_object(
    'price', pulse.erp_flow_defaults()->'price' || '{"on": false}'::jsonb,
    'send', pulse.erp_flow_defaults()->'send' || '{"required": ["name", "contactName", "phone", "email", "siteLocation"]}'::jsonb,
    'invoice', pulse.erp_flow_defaults()->'invoice' || '{"linesLocked": true}'::jsonb,
    'payment', pulse.erp_flow_defaults()->'payment' || '{"proofRequired": true}'::jsonb)
  when 'wl' then pulse.erp_flow_defaults()
  else pulse.erp_flow_defaults() end
$$;

-- migrate:down
-- Forward-only: proofs are kept.
