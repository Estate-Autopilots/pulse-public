-- migrate:up
-- R55 (owner, 11 Oct 2026): "Join finance-live (invoices, collections, package values) to projects and their places."
-- money_map() also returns the package values leadership records on client projects (pulse_priv.client_project_value,
-- UX-TASKS) with each project's place, so the map's pipeline shows what a package is worth where it is. Same access:
-- leadership with finance grants, every read audited.
create or replace function pulse.money_map() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform finance_live_authorize();perform audit_write('restricted_read','finance.map');
 return (with inv as materialized (select i.*,value_key(i.party) pk from money_invoice_places() i)
 select jsonb_build_object(
  'invoices',coalesce((select jsonb_agg(jsonb_build_object('number',number,'party',party,'day',day,'due',due,'taxable',taxable,'total',total,'status',status,
    'overdueDays',overdue_days,'paidBasis',paid_basis,'clientId',client_id,'projectId',project_id,'locationId',location_id,'basis',basis,'confidence',confidence) order by day desc) from inv),'[]'),
  'parties',coalesce((select jsonb_agg(jsonb_build_object('key',mp.party_key,'party',mp.party,'status',mp.status,'basis',mp.basis,'clientId',mp.client_id,
    'clientName',(select display_name from client where id=mp.client_id),'projectId',mp.project_id,'candidates',mp.candidates,
    'invoices',(select count(*) from inv where inv.pk=mp.party_key),'taxable',(select coalesce(sum(inv.taxable),0) from inv where inv.pk=mp.party_key)) order by mp.party)
   from pulse_priv.money_party mp where mp.org_id=current_org()),'[]'),
  'active',coalesce((select jsonb_agg(distinct jsonb_build_object('name',a.name,'projectId',pr.id,'locationId',m.location_id))
   from pulse_priv.finance_live_model f cross join lateral jsonb_array_elements_text(coalesce(f.body->'activeClients'->'names','[]')) a(name)
   left join lateral (select p.id from project p where p.kind='client_work' and value_key(coalesce(p.title,p.name))=value_key(a.name) order by p.start_month desc nulls last limit 1) pr on true
   left join project_location_member m on m.project_id=pr.id where f.org_id=current_org()),'[]'),
  'packages',coalesce((select jsonb_agg(jsonb_build_object('projectId',v.project_id,'locationId',m.location_id,'amount',v.amount,'currency',v.currency))
   from pulse_priv.client_project_value v left join project_location_member m on m.project_id=v.project_id where v.org_id=current_org()),'[]'),
  'evidenceEnd',(select body->'collections'->>'evidenceEnd' from pulse_priv.finance_live_model where org_id=current_org()),
  'asOf',(select body->>'asOf' from pulse_priv.finance_live_model where org_id=current_org()),
  'computedAt',(select computed_at from pulse_priv.finance_live_model where org_id=current_org())));
end $$;
-- migrate:down
