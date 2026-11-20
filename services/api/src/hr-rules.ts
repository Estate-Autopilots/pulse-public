/** Proposals are inert. Only dated, HR-confirmed versions participate in evaluation. */
export const proposals = {
 late_marks: {threshold:3,window:'calendar_month',deduction:0.5,balanceKind:'annual'},
 half_day: {netMinutes:270,arrivalCutoff:'13:00',timezone:''}, // on the company's clock: proposalsFor fills its zone
 advance_notice: {shortWorkingDays:3,longCalendarDays:14,longFromDays:3},
 emergency: {recordWorkingDays:2,notifyHours:2},
 special_routing: {unpaidDays:5,probationDays:2},
 leave_balance: {yearStart:4,monthlyDays:2,carryMax:12,balanceKind:'annual'},
 professional_tax: {state:'MH',slabs:[{category:'men',upTo:7500,monthly:0,february:0},{category:'men',upTo:10000,monthly:175,february:175},{category:'men',upTo:null,monthly:200,february:300},{category:'women',upTo:25000,monthly:0,february:0},{category:'women',upTo:null,monthly:200,february:300}]},
 exit: {confirmedDays:30,probationDays:15,settlementDays:45},
} as const;
export type RuleKey = keyof typeof proposals;
export type Rule = {key:RuleKey;config:Record<string,unknown>;effectiveFrom:string;confirmedAt:string;version:number};
export function activeRule(rules:Rule[],key:RuleKey,date:string) {return rules.filter(r=>r.key===key&&r.confirmedAt&&r.effectiveFrom<=date).sort((a,b)=>b.effectiveFrom.localeCompare(a.effectiveFrom)||b.version-a.version)[0];}
/** The proposals as HR sees them: the half-day cutoff is on the company's clock (its time zone, as the database checks). */
export const proposalsFor=(zone:string)=>({...proposals,half_day:{...proposals.half_day,timezone:zone}});
export function validateConfig(key:RuleKey,raw:unknown,zone:string):Record<string,unknown> {
 if(!Object.hasOwn(proposals,key)||!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Choose a rule and its settings');
 const c=raw as Record<string,unknown>,expected=Object.keys(proposals[key]);
 if(Object.keys(c).some(k=>!expected.includes(k))||expected.some(k=>!(k in c)))throw new Error('Complete the rule settings');
 for(const [k,v] of Object.entries(c)) {
  if(typeof (proposals[key] as Record<string,unknown>)[k]==='number' && (typeof v!=='number'||!Number.isFinite(v)||v<0||v>730))throw new Error('Use numbers from 0 to 730');
 }
 for(const k of ['threshold','netMinutes','shortWorkingDays','longCalendarDays','longFromDays','recordWorkingDays','notifyHours','unpaidDays','probationDays','confirmedDays','settlementDays'])if(k in c&&(!Number.isInteger(c[k])||Number(c[k])<1))throw new Error('Use positive whole numbers');
 if(key==='late_marks'&&(c.window!=='calendar_month'&&c.window!=='calendar_week'))throw new Error('Choose a calendar month or calendar week');
 if(key==='late_marks'&&(Number(c.deduction)<=0||Number(c.deduction)%0.5))throw new Error('Use a deduction in half days');
 if('balanceKind' in c && (typeof c.balanceKind!=='string'||!(/^[a-z][a-z0-9_]{1,23}$/).test(c.balanceKind)))throw new Error('Choose the balance to use');
 if(key==='half_day'&&(c.timezone!==zone||!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(c.arrivalCutoff))))throw new Error('Choose a cutoff on the company\'s clock');
 if(key==='leave_balance'&&(!Number.isInteger(c.yearStart)||Number(c.yearStart)<1||Number(c.yearStart)>12||Number(c.monthlyDays)%0.5||Number(c.carryMax)%0.5))throw new Error('Choose a month and half-day balance amounts');
 if(key==='professional_tax') {
  if(c.state!=='MH'||!Array.isArray(c.slabs)||c.slabs.length>20)throw new Error('Use Maharashtra slabs');
  for(const category of ['men','women']) {
   const bands=c.slabs.filter(s=>s.category===category);let last=-1;
   if(!bands.length||bands.at(-1)?.upTo!==null)throw new Error('Each category needs an unlimited final slab');
   bands.forEach((s,i)=>{if(!s||Object.keys(s).sort().join(',')!=='category,february,monthly,upTo'||![s.monthly,s.february].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=2500)|| (s.upTo===null ? i!==bands.length-1 : typeof s.upTo!=='number'||!Number.isFinite(s.upTo)||s.upTo<=last))throw new Error('Slabs need increasing limits and valid tax amounts');last=s.upTo??Infinity;});
  }
  if(c.slabs.some(s=>!['men','women'].includes(s.category)))throw new Error('Choose men or women for each slab');
 }
 return c;
}
export function professionalTax(rule:Rule|undefined,gross:number,category:string|null,state:string|null,exempt:boolean,month:string) {
 if(!rule||exempt||state!=='MH')return {amount:0,review:!!rule&&!exempt&&!state};
 if(!category||!['men','women'].includes(category))return {amount:0,review:true};
 const slab=(rule.config.slabs as {category:string;upTo:number|null;monthly:number;february:number}[]).find(s=>s.category===category&&(s.upTo===null||gross<=s.upTo));
 return {amount:slab?(month.slice(5,7)==='02'?slab.february:slab.monthly):0,review:!slab};
}
export function automaticHalfDay(rule:Rule|undefined,day:{netMinutes:number;arrival:string;complete:boolean;working:boolean;approvedRemote:boolean}) {
 return !!rule&&day.complete&&day.working&&!day.approvedRemote&&(day.netMinutes<Number(rule.config.netMinutes)||day.arrival>String(rule.config.arrivalCutoff));
}
export function noticeFlag(rule:Rule|undefined,days:number,workingNotice:number,calendarNotice:number) {
 if(!rule)return null;
 const long=days>=Number(rule.config.longFromDays),required=Number(long?rule.config.longCalendarDays:rule.config.shortWorkingDays),given=long?calendarNotice:workingNotice;
 return {required,given,unit:long?'calendar days':'working days',late:given<required};
}
export function specialRoute(rule:Rule|undefined,r:{paid:boolean;days:number;consecutive:number;from:string;to:string;probationFrom:string|null;probationTo:string|null;noticeFrom:string|null;noticeTo:string|null}) {
 if(!rule)return null;
 if(!r.paid&&r.days>Number(rule.config.unpaidDays))return {stage:'cofounder',reason:'long unpaid leave'};
 if(r.noticeFrom&&r.noticeTo&&r.from<=r.noticeTo&&r.to>=r.noticeFrom)return {stage:'hr',reason:'leave during notice period'};
 if(r.probationFrom&&r.probationTo&&r.from<=r.probationTo&&r.to>=r.probationFrom&&r.consecutive>Number(rule.config.probationDays))return {stage:'hr',reason:'probation leave'};
 return null;
}
