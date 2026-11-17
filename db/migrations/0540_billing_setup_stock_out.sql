-- migrate:up
-- BILLING-SETUP (18 Oct 2026, EST-1358/1359/1360): Billing fits each business, and an invoice moves the stock it sells.
--
-- 1. The field list and the industry pack per company, on erp_settings (its RLS, audit and grants from 0190 apply):
--    `pack` is the trade the company chose (dealer, agency, ...), the starting shape of its documents and catalogue;
--    `fields` holds its own switches ({"serials": true, "deliverables": false, ...}), which win over the pack's.
--    The keys and the packs themselves are data in services/api/src/billing-setup.ts and apps/web/app/erp/settings/
--    fields.ts; the database checks the shape and who writes (Billing writers, erp_require(true)).
-- 2. Stock out on issue: when an invoice leaves draft and the company keeps inventory, one "out" move per stock-tracked
--    item (quantities summed over its lines, packages counted through their parts), dated the invoice date, by the
--    issuer, noting the invoice number, in the same transaction. Short stock does not stop the invoice: the move is
--    recorded, on-hand goes below zero and the Billing log notes the shortfall ("stock_short"), so a company that turns
--    stock on before counting its opening stock can still bill. A company that wants stock to stay true switches on
--    "blockShortStock" in its field list: then short stock refuses the issue and nothing is numbered or moved.
--    Cancelling the invoice brings the stock back with one "in" move per item. Each move is made once per invoice, item
--    and direction (a unique index), so a retry cannot double it. Quotations, proformas and credit notes move nothing
--    (returns are a later card). Hand-made moves keep 0190's rule: never below zero.

alter table pulse.erp_settings
 add column fields jsonb not null default '{}' check(jsonb_typeof(fields)='object'),
 add column pack text check(pack ~ '^[a-z][a-z0-9_]{1,30}$'),
 add column pack_at timestamptz,
 add column pack_by uuid references pulse.person(id);

-- Saves the pack and the field switches: {pack: "dealer"|null, fields: {key: boolean}, inventoryEnabled?: boolean}.
create function pulse.erp_setup_save(p jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=erp_require(true);v_pack text;v_fields jsonb;k text;v jsonb;before erp_settings;
begin
 perform erp_bootstrap();
 if jsonb_typeof(p)<>'object' then raise exception 'Choose a pack and the fields to show' using errcode='22023';end if;
 v_pack:=nullif(btrim(coalesce(p->>'pack','')),'');
 if v_pack is not null and v_pack!~'^[a-z][a-z0-9_]{1,30}$' then raise exception 'Choose one of the industry packs' using errcode='22023';end if;
 v_fields:=coalesce(p->'fields','{}');
 if jsonb_typeof(v_fields)<>'object' then raise exception 'The field list is a set of switches' using errcode='22023';end if;
 if (select count(*) from jsonb_object_keys(v_fields))>80 then raise exception 'The field list has up to 80 switches' using errcode='22023';end if;
 for k,v in select key,value from jsonb_each(v_fields) loop
  if k!~'^[a-zA-Z][a-zA-Z0-9]{1,40}$' or jsonb_typeof(v)<>'boolean' then raise exception 'Each field is switched on or off' using errcode='22023';end if;
 end loop;
 if p ? 'inventoryEnabled' and jsonb_typeof(p->'inventoryEnabled')<>'boolean' then raise exception 'Stock is on or off' using errcode='22023';end if;
 select * into before from erp_settings where org_id=current_org() for update;
 update erp_settings set fields=v_fields,pack=v_pack,
  pack_at=case when v_pack is distinct from before.pack then now() else pack_at end,
  pack_by=case when v_pack is distinct from before.pack then me else pack_by end,
  inventory_enabled=case when p ? 'inventoryEnabled' then (p->>'inventoryEnabled')::boolean else inventory_enabled end,
  updated_by=me,updated_at=now()
 where org_id=current_org();
 perform erp_log('settings',null,'setup',jsonb_build_object('pack',v_pack,'packChanged',v_pack is distinct from before.pack,
  'on',(select coalesce(jsonb_agg(key order by key),'[]') from jsonb_each(v_fields) where value='true'::jsonb),
  'off',(select coalesce(jsonb_agg(key order by key),'[]') from jsonb_each(v_fields) where value='false'::jsonb)));
 return (select jsonb_build_object('pack',pack,'packAt',pack_at,'fields',fields,'inventoryEnabled',inventory_enabled) from erp_settings where org_id=current_org());
end $$;

-- ------------------------------------------------------------------------------------------- stock out on issue
create unique index erp_stock_move_document_once on pulse.erp_stock_move(document_id,item_id,kind) where document_id is not null;

-- 0190's guard, unchanged except that an invoice's own move may take stock below zero (the follower below decides).
create or replace function pulse.erp_stock_guard() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not coalesce((select inventory_enabled from erp_settings where org_id=current_org()),false) then
  raise exception 'Inventory is off for this company: turn it on in ERP settings' using errcode='22023';end if;
 if not exists(select 1 from erp_item where id=new.item_id and track_stock) then raise exception 'Turn on stock for this item first' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('erp-stock:'||new.item_id::text,0));
 if new.document_id is not null and exists(select 1 from erp_document where id=new.document_id and doc_type='invoice') then return new;end if;
 if (new.kind='out' and erp_on_hand(new.item_id)-new.qty<0) or (new.kind='adjust' and erp_on_hand(new.item_id)+new.qty<0) then
  raise exception 'Not enough stock: % on hand',erp_on_hand(new.item_id) using errcode='22023';end if;
 return new;
end $$;

create function pulse.erp_stock_follow() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare n record;moved int:=0;on_hand numeric;v_block boolean;v_short jsonb:='[]';
begin
 if new.doc_type<>'invoice' or new.status is not distinct from old.status then return null;end if;
 if not coalesce((select inventory_enabled from erp_settings where org_id=new.org_id),false) then return null;end if;
 v_block:=coalesce((select (fields->>'blockShortStock')::boolean from erp_settings where org_id=new.org_id and jsonb_typeof(fields->'blockShortStock')='boolean'),false);
 if old.status='draft' and new.status not in ('draft','cancelled') then
  -- What the invoice sells, per stock-tracked item: its own lines, and the parts of the packages on it.
  for n in select x.item_id,i.name,sum(x.qty) qty from (
    select l.item_id,l.qty from erp_line l where l.document_id=new.id and l.item_id is not null
    union all
    select p.item_id,l.qty*p.quantity from erp_line l join erp_item k on k.id=l.item_id and k.kind='package'
     join erp_package_part p on p.package_id=k.id where l.document_id=new.id and p.item_id is not null) x
   join erp_item i on i.id=x.item_id and i.track_stock and i.org_id=new.org_id
   where not exists(select 1 from erp_stock_move m where m.document_id=new.id and m.item_id=x.item_id and m.kind='out')
   group by x.item_id,i.name order by x.item_id loop
   perform pg_advisory_xact_lock(hashtextextended('erp-stock:'||n.item_id::text,0));
   on_hand:=erp_on_hand(n.item_id);
   if on_hand<n.qty and v_block then   -- (the API passes a sentence on only without brackets or quotes: the item's name loses them)
    raise exception 'Not enough stock of %: % on hand, this invoice needs %. Record the stock in first',btrim(regexp_replace(n.name,'[(){}"]+','','g')),
     trim_scale(on_hand),trim_scale(n.qty) using errcode='22023';
   end if;
   if on_hand<n.qty then v_short:=v_short||jsonb_build_object('item',n.item_id,'onHand',trim_scale(on_hand),'needs',trim_scale(n.qty));end if;
   insert into erp_stock_move(org_id,item_id,kind,qty,note,document_id,on_date,created_by)
   values(new.org_id,n.item_id,'out',n.qty,left('Invoice '||coalesce(new.number,''),500),new.id,new.issue_date,coalesce(new.issued_by,current_viewer()));
   moved:=moved+1;
  end loop;
  if moved>0 then perform erp_log('document',new.id,'stock_out',jsonb_build_object('items',moved,'number',new.number));end if;
  if jsonb_array_length(v_short)>0 then perform erp_log('document',new.id,'stock_short',jsonb_build_object('number',new.number,'items',v_short));end if;
 elsif new.status='cancelled' and old.status<>'draft' then
  for n in select m.item_id,m.qty from erp_stock_move m join erp_item i on i.id=m.item_id and i.track_stock
   where m.document_id=new.id and m.kind='out'
    and not exists(select 1 from erp_stock_move r where r.document_id=new.id and r.item_id=m.item_id and r.kind='in')
   order by m.item_id loop
   insert into erp_stock_move(org_id,item_id,kind,qty,note,document_id,created_by)
   values(new.org_id,n.item_id,'in',n.qty,left('Invoice '||coalesce(new.number,'')||' cancelled',500),new.id,current_viewer());
   moved:=moved+1;
  end loop;
  if moved>0 then perform erp_log('document',new.id,'stock_back',jsonb_build_object('items',moved,'number',new.number));end if;
 end if;
 return null;
end $$;
create trigger erp_stock_follow after update of status on pulse.erp_document for each row execute function pulse.erp_stock_follow();

revoke all on function pulse.erp_setup_save(jsonb),pulse.erp_stock_follow() from public;
grant execute on function pulse.erp_setup_save(jsonb) to pulse_api;
-- migrate:down
-- Forward-only: stock moves and the Billing log are kept as recorded.
