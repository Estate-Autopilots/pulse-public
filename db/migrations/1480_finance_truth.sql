-- migrate:up
-- FINANCE-TRUTH (owner, 4 Nov 2026; Kazuk in the 3 Nov meeting, lines 1457-1460, 1646, 1907-1916: "आपण जीएसटी चे पेमेंट
-- वेगळे घेतो आणि याचे वेगळे घेतो. अकाउंट दोन्ही वेगळे आहेत", we take the GST payment separately; the two accounts are
-- different). The finance numbers worked out from what Pulse itself records, each with where it comes from:
--  * Revenue is what clients have paid on invoices, net of GST: the base part of each payment, in the month it arrived.
--  * GST is its own receivable. The company names its GST account (fin_entry_settings.gst_account, one of the Cash book's
--    accounts); a payment recorded as paid into it (erp_payment.account) pays the invoice's GST first, any other payment
--    pays its base first. So a GST receipt still to come shows as GST outstanding, never as missing revenue.
--  * Collections are the bank lines (FIN-LIVE statements, leadership only) for the months they cover, else the money
--    received typed in the Cash book. Expenses are Cash book spending net of input GST; taxes and GST paid to the
--    government are shown on their own. HR cost (locked payroll) is added by the API, which holds the payroll keyring.
--  * A salesperson's own quotations, invoices and collections (sales_numbers); leadership and Finance see anyone's.
-- The two columns are added only when missing, so a Billing change that brings the same ones applies cleanly.

alter table pulse.erp_payment add column if not exists account text check(length(account)<=80);
alter table pulse.fin_entry_settings add column if not exists gst_account text check(length(gst_account)<=80);

-- The Cash book's accounts (0880's defaults until leadership changes them) and the one that takes GST.
create function pulse.finance_accounts() returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('accounts',to_jsonb(coalesce((select s.accounts from fin_entry_settings s where s.org_id=current_org()),
   array['HDFC current','ICICI current','Company card','Cash','UPI'])),
  'gstAccount',(select nullif(btrim(s.gst_account),'') from fin_entry_settings s where s.org_id=current_org()))
$$;
create function pulse.finance_gst_account_set(p_account text) returns text language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a text:=nullif(btrim(coalesce(p_account,'')),'');
begin
 if current_viewer() is null or not fin_entry_approver() then raise exception 'Leadership names the GST account' using errcode='42501'; end if;
 if a is not null and not exists(select 1 from jsonb_array_elements_text(finance_accounts()->'accounts') x where x=a) then
  raise exception 'Choose one of the Cash book accounts' using errcode='22023'; end if;
 insert into fin_entry_settings(org_id,gst_account,updated_by) values(current_org(),a,current_viewer())
 on conflict(org_id) do update set gst_account=excluded.gst_account,updated_by=excluded.updated_by,updated_at=now();
 return a;
end $$;

-- Which account a recorded payment arrived in (Billing writers; the ERP log keeps the change).
create function pulse.erp_payment_account(p_payment uuid,p_account text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=erp_require(true);doc uuid;a text:=nullif(btrim(coalesce(p_account,'')),'');
begin
 if length(a)>80 then raise exception 'Keep the account name short' using errcode='22023'; end if;
 select document_id into doc from erp_payment where id=p_payment and org_id=current_org() and voided_at is null;
 if doc is null then raise exception 'Payment not found' using errcode='P0002'; end if;
 update erp_payment set account=a where id=p_payment and account is distinct from a;
 if found then perform erp_log('document',doc,'payment_account',jsonb_build_object('payment',p_payment,'account',a)); end if;
end $$;

-- Each live payment on an issued invoice split into base and GST (p_doc: one invoice, else the organisation's). Caps are
-- the invoice's figures less its credit notes; a payment into the GST account fills the GST first, any other fills the
-- base first (in the order received), and what does not fit goes to the other part while it has room. Payments never
-- exceed the balance (erp_payment_add), but a credit note issued after full payment shrinks the caps: what then fits
-- neither part is `overpaid` (paid beyond the invoice, a refund due), never extra GST or revenue.
-- The GST account is matched by its name (as fin_entry.account_to is): renaming it in the Cash book's accounts leaves
-- earlier payments under the old name, and Billing moves them with "Paid into" on each payment.
create function pulse.finance_receipt_split(p_doc uuid default null) returns table(document_id uuid,payment_id uuid,received_on date,amount bigint,tds bigint,base bigint,gst bigint,overpaid bigint,into_gst boolean)
language sql stable security definer set search_path=pulse,pg_temp as $$
 with g as (select lower(finance_accounts()->>'gstAccount') a),
 caps as (
  select d.id,greatest(d.cgst+d.sgst+d.igst-coalesce(c.gst,0),0) gc,greatest(d.total-coalesce(c.total,0),0) tc
  from erp_document d left join lateral (select sum(x.cgst+x.sgst+x.igst) gst,sum(x.total) total from erp_document x
   where x.org_id=d.org_id and x.against_id=d.id and x.doc_type='credit_note' and x.status not in ('draft','cancelled')) c on true
  where d.org_id=current_org() and d.doc_type='invoice' and d.status not in ('draft','cancelled','declined') and (p_doc is null or d.id=p_doc)
 ), pay as (
  select p.document_id,p.id,p.received_on,p.created_at,p.amount,p.tds,p.amount+p.tds paid,coalesce(lower(btrim(p.account))=(select a from g),false) into_gst,
   greatest(c.tc-c.gc,0) bc,c.gc
  from erp_payment p join caps c on c.id=p.document_id where p.org_id=current_org() and p.voided_at is null
 ), run as (
  select y.*,sum(y.paid) over (partition by y.document_id,y.into_gst order by y.received_on,y.created_at,y.id) cum from pay y
 ), part as (
  select r.*,case when r.into_gst then least(r.cum,r.gc)-least(r.cum-r.paid,r.gc) else least(r.cum,r.bc)-least(r.cum-r.paid,r.bc) end own from run r
 ), rest as (
  -- The other part's room is its cap less what its own payments filled; the spill fills it in the order received.
  select p.*,p.paid-p.own extra,
   sum(p.paid-p.own) over (partition by p.document_id,p.into_gst order by p.received_on,p.created_at,p.id) cum_x,
   case when p.into_gst then greatest(p.bc-coalesce(sum(p.own) filter (where not p.into_gst) over (partition by p.document_id),0),0)
    else greatest(p.gc-coalesce(sum(p.own) filter (where p.into_gst) over (partition by p.document_id),0),0) end room
  from part p
 ), fit as (select r.*,least(r.cum_x,r.room)-least(r.cum_x-r.extra,r.room) fill from rest r)
 select document_id,id,received_on,amount,tds,
  case when into_gst then fill else own end,case when into_gst then own else fill end,extra-fill,into_gst from fit
$$;
-- What is still due on each issued invoice (p_doc: one invoice), base and GST apart.
create function pulse.finance_invoice_due(p_doc uuid default null) returns table(document_id uuid,base_due bigint,gst_due bigint)
language sql stable security definer set search_path=pulse,pg_temp as $$
 with s as (select document_id,sum(base) base,sum(gst) gst from finance_receipt_split(p_doc) group by 1)
 select d.id,greatest(d.total-coalesce(c.total,0)-greatest(d.cgst+d.sgst+d.igst-coalesce(c.gst,0),0)-coalesce(s.base,0),0),
  greatest(d.cgst+d.sgst+d.igst-coalesce(c.gst,0)-coalesce(s.gst,0),0)
 from erp_document d left join s on s.document_id=d.id
 left join lateral (select sum(x.cgst+x.sgst+x.igst) gst,sum(x.total) total from erp_document x
  where x.org_id=d.org_id and x.against_id=d.id and x.doc_type='credit_note' and x.status not in ('draft','cancelled')) c on true
 where d.org_id=current_org() and d.doc_type='invoice' and d.status not in ('draft','cancelled','declined') and (p_doc is null or d.id=p_doc)
$$;

-- One invoice's base and GST still due (the payment drawer offers them), worked out for that invoice alone.
create function pulse.erp_invoice_due(p_doc uuid) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
begin
 perform erp_require(false);
 return (select jsonb_build_object('baseDue',u.base_due,'gstDue',u.gst_due) from finance_invoice_due(p_doc) u where u.document_id=p_doc);
end $$;

-- The salesperson of a document: a salesperson named on it or on the quotation or proforma it was made from, else who
-- sent or made that origin when it is a quotation or proforma (the salesperson's own work). An invoice made with no
-- quotation behind it and no salesperson named has none: whoever issued it in Billing (normally Finance) is not
-- credited with the sale, and the numbers show it under "No salesperson".
create function pulse.erp_salesperson(d pulse.erp_document) returns uuid language sql stable security definer set search_path=pulse,pg_temp as $$
 with recursive up(id,source_id,sp,depth) as (
  select d.id,d.source_id,d.salesperson_id,0
  union all select x.id,x.source_id,x.salesperson_id,u.depth+1 from up u join erp_document x on x.org_id=d.org_id and x.id=u.source_id where u.sp is null and u.depth<4)
 select coalesce((select sp from up where sp is not null order by depth limit 1),
  (select erp_followup_person(x) from up u join erp_document x on x.org_id=d.org_id and x.id=u.id
    where x.doc_type in ('quotation','proforma') order by u.depth desc limit 1))
$$;

-- One period's numbers, month by month, for leadership and the Finance role (the Cash book's readers). Bank lines are
-- read only with the finance amount grants (as FIN-LIVE's views), and that read is audited.
create function pulse.finance_numbers(p_from date,p_to date) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare org uuid:=current_org();today date:=(now() at time zone org_time_zone())::date;
 f date:=date_trunc('month',coalesce(p_from,today))::date;t date:=(date_trunc('month',coalesce(p_to,today))+interval '1 month -1 day')::date;
 bank_ok boolean:=money_can('money.read') and money_can('money.amount.read');acc jsonb:=finance_accounts();ga text;result jsonb;
begin
 if current_viewer() is null or not fin_entry_can(false) then raise exception 'Finance numbers are for leadership and the Finance role' using errcode='42501'; end if;
 if t<f or t-f>800 then raise exception 'Choose a period of up to two years' using errcode='22023'; end if;
 ga:=lower(acc->>'gstAccount');
 if bank_ok then perform audit_write('restricted_read','finance.numbers'); end if;
 with months as (select to_char(m,'YYYY-MM') as month from generate_series(f,t,interval '1 month') m),
 split as (select * from finance_receipt_split()),
 docs as (select to_char(d.issue_date,'YYYY-MM') as month,d.doc_type,count(*) n,sum(d.taxable) taxable,sum(d.cgst+d.sgst+d.igst) gst,sum(d.total) total
  from erp_document d where d.org_id=org and d.doc_type in ('invoice','credit_note') and d.status not in ('draft','cancelled','declined') and d.issue_date between f and t group by 1,2),
 rec as (select to_char(received_on,'YYYY-MM') as month,count(*) n,sum(base) base,sum(gst) filter (where into_gst) gst_g,sum(gst) filter (where not into_gst) gst_m,
  sum(tds) tds,sum(amount) cash,sum(overpaid) overpaid from split where received_on between f and t group by 1),
 paid as (select to_char(l.last,'YYYY-MM') as month,count(*) n from (select s.document_id,max(s.received_on) last from split s group by 1) l
  join erp_document d on d.id=l.document_id and d.status='paid' where l.last between f and t group by 1),
 bank as (select r.body->>'month' as month,count(*) n,
  sum(round((r.body->>'amount')::numeric*100)) filter (where r.body->>'category'='Client receipts') client,
  sum(round((r.body->>'amount')::numeric*100)) filter (where r.body->>'category' is distinct from 'Client receipts') other
  -- A statement line does not say which of the company's accounts it is (FIN-LIVE keeps the sheet it came from), so
  -- the GST account's share is told from Billing's payments and the Cash book, not from bank lines.
  from pulse_priv.finance_live_record r where bank_ok and r.org_id=org and r.kind='bank_line' and r.body->>'direction'='in'
   and coalesce(r.body->>'selected','true')<>'false' and r.body->>'amount' ~ '^[0-9]+(\.[0-9]+)?([eE][+]?[0-9]+)?$'
   and r.body->>'month' between to_char(f,'YYYY-MM') and to_char(t,'YYYY-MM') group by 1),
 book_in as (select to_char(entry_date,'YYYY-MM') as month,count(*) n,sum(amount_minor) total,
  sum(amount_minor) filter (where ga is not null and lower(btrim(account_to))=ga) into_gst
  from fin_entry where org_id=org and deleted_at is null and status='approved' and kind='income' and entry_date between f and t group by 1),
 spend as (select to_char(entry_date,'YYYY-MM') as month,coalesce(nullif(btrim(category),''),'Uncategorised') category,count(*) n,
  sum(amount_minor-gst_minor) net,sum(gst_minor) gst
  -- Paid bills count in their entry's month: the Cash book keeps no separate paid date. A refund paid to a client is
  -- not spending: it is taken off revenue (refunds below).
  from fin_entry where org_id=org and deleted_at is null and status='approved' and direction='out'
   and (kind='expense' or (kind='bill' and bill_status='paid')) and entry_date between f and t group by 1,2),
 refunds as (select to_char(entry_date,'YYYY-MM') as month,count(*) n,sum(amount_minor-gst_minor) net from fin_entry
  where org_id=org and deleted_at is null and status='approved' and direction='out' and kind='refund' and entry_date between f and t group by 1),
 spend_m as (select month,sum(n) n,sum(net) filter (where category !~* '^tax') net,sum(gst) filter (where category !~* '^tax') gst,
  sum(net) filter (where category ~* 'salar|payroll') salaries,sum(net+gst) filter (where category ~* '^tax') taxes,
  jsonb_agg(jsonb_build_object('category',category,'net',net,'lines',n) order by net desc) filter (where category !~* '^tax') categories from spend group by 1),
 unpaid as (select count(*) n,coalesce(sum(amount_minor),0) total from fin_entry where org_id=org and deleted_at is null and status='approved' and kind='bill' and bill_status='unpaid'),
 due as (select u.document_id,u.base_due,u.gst_due from finance_invoice_due() u where u.base_due>0 or u.gst_due>0),
 -- Each quotation's and invoice's salesperson, worked out once.
 spd as (select d.id,d.doc_type,d.taxable,d.issue_date,erp_salesperson(d) sp from erp_document d
  where d.org_id=org and d.doc_type in ('quotation','invoice') and d.status not in ('draft','cancelled')),
 sp_docs as (select sp,count(*) filter (where doc_type='quotation') quotes,coalesce(sum(taxable) filter (where doc_type='quotation'),0) quoted,
  coalesce(sum(taxable) filter (where doc_type='invoice'),0) invoiced from spd where issue_date between f and t group by 1),
 sp_rev as (select x.sp,sum(s.base) revenue from split s join spd x on x.id=s.document_id where s.received_on between f and t group by 1),
 sp as (select coalesce(a.sp,b.sp) id,coalesce(a.quotes,0) quotes,coalesce(a.quoted,0) quoted,coalesce(a.invoiced,0) invoiced,coalesce(b.revenue,0) revenue
  from sp_docs a full join sp_rev b on coalesce(a.sp::text,'')=coalesce(b.sp::text,'')),
 -- Payments that do not say which account they arrived in, on invoices whose GST is still due: one of them may be the
 -- GST, recorded before Billing kept the account (Billing corrects it with "Paid into" on the payment).
 unsaid as (select s.payment_id,s.document_id,s.received_on,s.amount from split s join due u on u.document_id=s.document_id and u.gst_due>0
  join erp_payment p on p.id=s.payment_id where ga is not null and nullif(btrim(p.account),'') is null)
 select jsonb_build_object('from',to_char(f,'YYYY-MM'),'to',to_char(t,'YYYY-MM'),'today',today::text,'bank',bank_ok,
  'accounts',acc->'accounts','gstAccount',acc->'gstAccount','canSetAccount',fin_entry_approver(),
  'bankEnd',case when bank_ok then (select max(r.body->>'date') from pulse_priv.finance_live_record r where r.org_id=org and r.kind='bank_line' and r.body->>'direction'='in') end,
  'months',(select coalesce(jsonb_agg(jsonb_build_object('month',m.month,
    'invoiced',jsonb_build_object('count',coalesce(i.n,0),'taxable',coalesce(i.taxable,0),'gst',coalesce(i.gst,0),'total',coalesce(i.total,0)),
    'credited',jsonb_build_object('count',coalesce(cn.n,0),'taxable',coalesce(cn.taxable,0),'gst',coalesce(cn.gst,0),'total',coalesce(cn.total,0)),
    'receipts',jsonb_build_object('count',coalesce(r.n,0),'base',coalesce(r.base,0),'gstInGstAccount',coalesce(r.gst_g,0),'gstInMain',coalesce(r.gst_m,0),'tds',coalesce(r.tds,0),'cash',coalesce(r.cash,0),'over',coalesce(r.overpaid,0)),
    'refunds',jsonb_build_object('lines',coalesce(rf.n,0),'net',coalesce(rf.net,0)),
    'paidInvoices',coalesce(p.n,0),
    'bankLines',case when b.n is null then null else jsonb_build_object('lines',b.n,'client',coalesce(b.client,0),'other',coalesce(b.other,0)) end,
    'book',jsonb_build_object('lines',coalesce(bi.n,0),'total',coalesce(bi.total,0),'intoGst',coalesce(bi.into_gst,0)),
    'spend',jsonb_build_object('lines',coalesce(s.n,0),'net',coalesce(s.net,0),'gst',coalesce(s.gst,0),'salaries',coalesce(s.salaries,0),'taxes',coalesce(s.taxes,0),'categories',coalesce(s.categories,'[]'))
   ) order by m.month),'[]') from months m
    left join docs i on i.month=m.month and i.doc_type='invoice' left join docs cn on cn.month=m.month and cn.doc_type='credit_note'
    left join rec r on r.month=m.month left join paid p on p.month=m.month left join bank b on b.month=m.month
    left join book_in bi on bi.month=m.month left join spend_m s on s.month=m.month left join refunds rf on rf.month=m.month),
  'unpaidBills',(select jsonb_build_object('count',n,'total',total) from unpaid),
  'outstanding',jsonb_build_object('invoices',(select count(*) from due),'base',(select coalesce(sum(base_due),0) from due),
   'gst',(select coalesce(sum(gst_due),0) from due),'gstInvoices',(select count(*) from due where gst_due>0),
   'items',(select coalesce(jsonb_agg(x order by (x->>'gstDue')::bigint desc,(x->>'baseDue')::bigint desc),'[]') from (select jsonb_build_object('id',d.id,'number',d.number,'issueDate',d.issue_date::text,
     'dueDate',d.due_date::text,'buyer',coalesce(nullif(btrim(d.buyer->>'name'),''),c.display_name),'baseDue',u.base_due,'gstDue',u.gst_due,'total',d.total) x
     from due u join erp_document d on d.id=u.document_id left join client c on c.org_id=d.org_id and c.id=d.client_id order by u.gst_due desc,u.base_due desc,d.issue_date limit 30) z)),
  'salespeople',(select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'name',coalesce(p.display_name,'No salesperson'),'quotes',x.quotes,'quoted',x.quoted,
     'invoiced',x.invoiced,'revenue',x.revenue) order by x.id is null,x.revenue desc,x.quoted desc,p.display_name),'[]')
   from sp x left join person p on p.org_id=org and p.id=x.id),
  'unsaidPayments',jsonb_build_object('count',(select count(*) from unsaid),
   'items',(select coalesce(jsonb_agg(jsonb_build_object('id',z.payment_id,'documentId',z.document_id,'number',d.number,'receivedOn',z.received_on::text,'amount',z.amount,
     'buyer',coalesce(nullif(btrim(d.buyer->>'name'),''),c.display_name)) order by z.received_on desc),'[]')
    from (select * from unsaid order by received_on desc limit 10) z join erp_document d on d.id=z.document_id left join client c on c.org_id=d.org_id and c.id=d.client_id))
 ) into result;
 return result;
end $$;

-- A salesperson's own numbers for a period: quotations and invoices issued in it (with status, what is paid and what is
-- due), and what their clients paid in it. Leadership and the Finance role (ERP readers) may open anyone's.
create function pulse.sales_numbers(p_person uuid,p_from date,p_to date) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer();org uuid:=current_org();today date:=(now() at time zone org_time_zone())::date;who uuid:=coalesce(p_person,current_viewer());
 f date:=date_trunc('month',coalesce(p_from,today))::date;t date:=(date_trunc('month',coalesce(p_to,today))+interval '1 month -1 day')::date;
 reader boolean:=erp_can(false);nm text;result jsonb;
begin
 if me is null or not exists(select 1 from person where org_id=org and id=me and side='staff') then
  raise exception 'Sales numbers belong to a staff person' using errcode='42501'; end if;
 if who<>me and not reader then raise exception 'Only leadership and Finance see another person''s sales' using errcode='42501'; end if;
 select display_name into nm from person where org_id=org and id=who and side='staff';
 if nm is null then raise exception 'Person not found' using errcode='P0002'; end if;
 if t<f or t-f>800 then raise exception 'Choose a period of up to two years' using errcode='22023'; end if;
 with mine as (select d.* from erp_document d where d.org_id=org and d.doc_type in ('quotation','invoice') and d.status<>'cancelled' and erp_salesperson(d)=who),
 split as (select s.* from finance_receipt_split() s join mine d on d.id=s.document_id),
 due as (select u.* from finance_invoice_due() u join mine d on d.id=u.document_id),
 q as (select d.* from mine d where d.doc_type='quotation' and coalesce(case when d.status='draft' then (d.created_at at time zone org_time_zone())::date end,d.issue_date) between f and t),
 i as (select d.*,u.base_due,u.gst_due from mine d left join due u on u.document_id=d.id where d.doc_type='invoice' and d.status<>'draft' and d.issue_date between f and t),
 c as (select * from split where received_on between f and t),
 owed as (select d.*,u.base_due,u.gst_due from mine d join due u on u.document_id=d.id where u.base_due+u.gst_due>0)
 select jsonb_build_object('person',jsonb_build_object('id',who,'name',nm,'self',who=me),'from',to_char(f,'YYYY-MM'),'to',to_char(t,'YYYY-MM'),'today',today::text,'canOpenErp',reader,
  'quotes',jsonb_build_object('count',(select count(*) from q),'value',(select coalesce(sum(taxable),0) from q where status<>'draft'),
   'won',(select count(*) from q where status in ('accepted','converted')),'wonValue',(select coalesce(sum(taxable),0) from q where status in ('accepted','converted')),
   'open',(select count(*) from q where status in ('issued','sent')),'drafts',(select count(*) from q where status='draft'),
   'items',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'number',number,'status',status,'issueDate',case when status<>'draft' then issue_date::text end,
     'buyer',coalesce(nullif(btrim(buyer->>'name'),''),(select display_name from client where org_id=org and id=q.client_id)),'taxable',taxable,'total',total,
     'ownerApprovalNeeded',coalesce(owner_approval='needed',false),'named',salesperson_id is not distinct from me) order by coalesce(issue_date,created_at::date) desc,created_at desc),'[]') from q)),
  'invoices',jsonb_build_object('count',(select count(*) from i),'taxable',(select coalesce(sum(taxable),0) from i),'total',(select coalesce(sum(total),0) from i),
   'paid',(select count(*) from i where status='paid'),
   'items',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'number',number,'status',status,'issueDate',issue_date::text,'dueDate',due_date::text,
     'buyer',coalesce(nullif(btrim(buyer->>'name'),''),(select display_name from client where org_id=org and id=i.client_id)),'taxable',taxable,'gst',cgst+sgst+igst,'total',total,
     'baseDue',coalesce(base_due,0),'gstDue',coalesce(gst_due,0)) order by issue_date desc,number desc),'[]') from i)),
  'collections',jsonb_build_object('count',(select count(*) from c),'cash',(select coalesce(sum(amount),0) from c),'base',(select coalesce(sum(base),0) from c),
   'gst',(select coalesce(sum(gst),0) from c),'tds',(select coalesce(sum(tds),0) from c),
   'months',(select coalesce(jsonb_agg(jsonb_build_object('month',m,'cash',cash,'base',base,'gst',gst) order by m),'[]') from
     (select to_char(received_on,'YYYY-MM') m,sum(amount) cash,sum(base) base,sum(gst) gst from c group by 1) x)),
  'open',jsonb_build_object('count',(select count(*) from owed),'base',(select coalesce(sum(base_due),0) from owed),'gst',(select coalesce(sum(gst_due),0) from owed),
   'overdue',(select count(*) from owed where due_date<today),'overdueAmount',(select coalesce(sum(base_due+gst_due),0) from owed where due_date<today)),
  'team',case when reader then (select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.display_name) order by p.display_name),'[]') from person p
    where p.org_id=org and p.side='staff' and exists(select 1 from erp_document d where d.org_id=org and d.doc_type in ('quotation','invoice') and d.status<>'cancelled' and erp_salesperson(d)=p.id)) end
 ) into result;
 return result;
end $$;

revoke all on function pulse.finance_accounts(),pulse.finance_gst_account_set(text),pulse.erp_payment_account(uuid,text),pulse.erp_invoice_due(uuid),pulse.finance_receipt_split(uuid),
 pulse.finance_invoice_due(uuid),pulse.erp_salesperson(pulse.erp_document),pulse.finance_numbers(date,date),pulse.sales_numbers(uuid,date,date) from public;
grant execute on function pulse.finance_accounts(),pulse.finance_gst_account_set(text),pulse.erp_payment_account(uuid,text),pulse.erp_invoice_due(uuid),
 pulse.finance_numbers(date,date),pulse.sales_numbers(uuid,date,date) to pulse_api;

-- migrate:down
-- Forward-only: the account a payment arrived in and the named GST account are kept.
