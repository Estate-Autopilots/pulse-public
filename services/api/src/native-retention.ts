import {Pool} from 'pg';
type Counts={eventsRemoved:number;sourceAcksRemoved:number;batchesRemoved:number;expiredTokensRemoved:number;pushReceiptsRemoved:number};
/** Root-scheduled worker: bounded raw evidence retention, counts only in diagnostics. UX-TENANT: every active company,
 *  each in its own transaction. */
export async function pruneNative(pool:Pool){const total:Counts={eventsRemoved:0,sourceAcksRemoved:0,batchesRemoved:0,expiredTokensRemoved:0,pushReceiptsRemoved:0};
 const orgs=(await pool.query('select pulse.list_active_orgs() org')).rows.map(r=>r.org as string);
 for(const org of orgs){const c=await pool.connect();try{await c.query('begin');await c.query("select set_config('pulse.org_id',$1,true)",[org]);const raw=(await c.query('select pulse.native_prune() d')).rows[0].d as Partial<Counts>;const pushes=await c.query("delete from pulse.native_push_delivery where notification_id in (select id from pulse.notification where created_at<now()-interval '7 days')");await c.query('commit');
  for(const key of Object.keys(total) as (keyof Counts)[])total[key]+=Number(key==='pushReceiptsRemoved'?pushes.rowCount??0:raw[key]??0);}catch(e){await c.query('rollback');throw e;}finally{c.release();}}
 return total;}
if(import.meta.url===`file://${process.argv[1]}`){const pool=new Pool({connectionString:process.env.PULSE_DATABASE_URL_WORKER??process.env.DATABASE_URL,...(!process.env.PULSE_DATABASE_URL_WORKER?{options:'-c role=pulse_worker'}:{})});try{console.log(JSON.stringify(await pruneNative(pool)));}catch{console.error('Native retention worker unavailable');process.exitCode=1;}finally{await pool.end();}}
