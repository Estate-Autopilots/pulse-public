import type { FastifyInstance } from 'fastify';
import { admin,fail,hr,type Tx } from './routes.js';
const quote=(s:string)=>`'${s.replaceAll("'","'\\''")}'`;
type GoogleMember={email:string;role:string;type:string;status?:string};
export function registerGroupRoutes(app:FastifyInstance,{tx}:{tx:Tx}){
 app.get('/api/v0/groups',req=>tx(req,async(c,v)=>{
  if(!v.person)fail(403,'Use an individual employee account');
  await c.query('select pulse.chat_refresh()');
  const people=(await c.query(`select p.id,p.display_name name,pp.pod,pp.department team,pp.username,
   coalesce((select array_agg(a.handle) from pulse.account a where a.holder_person_id=p.id and a.provider='google' and not a.is_shared and a.purpose like 'Workspace%'),'{}') accounts,
   coalesce((select array_agg(r.role_key) from pulse.role_assignment r where r.person_id=p.id and current_date between r.valid_from and coalesce(r.valid_to,'infinity')),'{}') roles
   from pulse.person p join pulse.people_profile pp on pp.person_id=p.id where p.side='staff' and pulse.chat_current(p.id) order by p.display_name`)).rows;
  const groups=(await c.query('select address,name,aliases,members,source_kind "sourceKind",source_value "sourceValue",observed_at "observedAt" from pulse.workspace_group order by address')).rows.map(g=>{
   const expected=people.filter(p=>g.sourceKind==='all'||g.sourceKind==='pod'&&p.pod===g.sourceValue||g.sourceKind==='team'&&p.team?.toLowerCase()===g.sourceValue?.toLowerCase()||g.sourceKind==='role'&&p.roles.some((r:string)=>g.sourceValue?.split(',').includes(r)));
   const expectedAccounts=new Set<string>(expected.flatMap(p=>p.accounts));const observed=(g.members as GoogleMember[]).map(m=>({...m,person:people.find(p=>p.accounts.includes(m.email.toLowerCase()))?.name??null}));
   const missing=[...expectedAccounts].filter(a=>!observed.some(m=>m.email.toLowerCase()===a.toLowerCase()));
   const extra=observed.filter(m=>!expectedAccounts.has(m.email.toLowerCase()));
   // Prepare individual changes. Never remove owners, managers, nested groups or external/system members automatically.
   const commands=g.sourceKind?[...missing.map(a=>`gam update group ${quote(g.address)} add member ${quote(a)}`),...extra.filter(m=>m.role==='MEMBER'&&m.type==='USER'&&people.some(p=>p.accounts.includes(m.email.toLowerCase()))).map(m=>`gam update group ${quote(g.address)} remove member ${quote(m.email)}`)]:[];
   return {...g,members:observed,expected,missing:g.sourceKind?missing:[],extra:g.sourceKind?extra:[],withoutWorkspace:expected.filter(p=>!p.accounts.length),commands:hr(v)?commands:undefined};
  });
  const aliases=(await c.query('select address,primary_address "primaryAddress",kind,editable,observed_at "observedAt" from pulse.workspace_alias order by address')).rows;
  const sync=(await c.query("select finished_at \"at\",ok,error from pulse.sync_run where source='workspace_directory' order by started_at desc limit 1")).rows[0]??null;
  const channels=(await c.query("select id,name,kind,address,(select count(*)::int from pulse.chat_member cm where cm.channel_id=ch.id and pulse.chat_current(cm.person_id)) members from pulse.chat_channel ch where kind<>'direct' order by kind,name")).rows;
  // DE-EA: the Workspace groups a company expects are its own tenant config (tenant/workspace_groups: {domain, required}),
  // never a list in code; a company without one has none "missing".
  const want=(await c.query("select body from pulse.tenant_config where org_id=pulse.current_org() and doc_kind='tenant' and doc_key='workspace_groups' and is_active")).rows[0]?.body as {domain?:unknown;required?:unknown}|undefined;
  const domain=typeof want?.domain==='string'?want.domain.toLowerCase():null;
  const required=domain&&Array.isArray(want?.required)?want!.required.filter((x):x is string=>typeof x==='string'&&/^[a-z0-9._-]{1,64}$/.test(x)).filter(local=>!groups.some(g=>g.address.toLowerCase()===`${local}@${domain}`)):[];
  return {groups,aliases,sync,people,channels,canMap:admin(v),canPlan:hr(v),required,planOnly:true};
 }));
 app.post<{Body:{address:string;kind:string|null;value?:string}}>('/api/v0/groups/mapping',{schema:{body:{type:'object'}}},req=>tx(req,async(c,v)=>{
  if(!admin(v)||!v.person)fail(403,'An admin confirms group mappings');const b=req.body;
  if(b.kind!==null&&!['all','pod','team','role'].includes(b.kind))fail(400,'Choose a membership source');
  if(b.kind==='pod'&&!(await c.query("select 1 from pulse.unit where kind='pod' and valid_to is null and name=$1",[b.value])).rows[0])fail(400,'Choose a current pod');
  if(b.kind==='team'&&!(await c.query('select 1 from pulse.people_profile where department=$1',[b.value])).rows[0])fail(400,'Choose a current team');
  if(b.kind==='role'&&!String(b.value).split(',').every(r=>['admin','leadership','hr','manager','pgs','head_pgs'].includes(r)))fail(400,'Choose explicit access roles');
  const r=await c.query('update pulse.workspace_group set source_kind=$1,source_value=$2 where address=$3',[b.kind,b.kind==='all'||b.kind===null?null:b.value,b.address]);if(!r.rowCount)fail(404,'Group unavailable');
  await c.query('select pulse.chat_refresh()');return {ok:true};
 }));
}
