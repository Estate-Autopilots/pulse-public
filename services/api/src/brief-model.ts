export type Schedule={subscribed:boolean;timezone:string;dailyTime:string|null;weeklyDay:number;quietStart:string;quietEnd:string;shift:{start:string;end:string;workDays:number[]}|null;holidays:string[];leaveDates:{from:string;to:string}[]};
export function briefSlot(now:Date,s:Schedule) {
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:s.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));
 const today=`${parts.year}-${parts.month}-${parts.day}`,clock=`${parts.hour}:${parts.minute}`;
 const shift=s.shift,overnight=!!shift&&shift.start>shift.end;
 const workDate=overnight&&clock<shift!.end?new Date(Date.parse(today+'T12:00:00Z')-86400000).toISOString().slice(0,10):today;
 const dow=new Date(workDate+'T12:00:00Z').getUTCDay()||7;
 const quiet=s.quietStart===s.quietEnd?false:s.quietStart<s.quietEnd?clock>=s.quietStart&&clock<s.quietEnd:clock>=s.quietStart||clock<s.quietEnd;
 const dueTime=(s.dailyTime??shift?.start??'09:00').slice(0,5);
 const due=workDate<today||clock>=dueTime;
 const onLeave=s.leaveDates.some(l=>workDate>=l.from&&workDate<=l.to),working=(shift?.workDays??[1,2,3,4,5,6]).includes(dow)&&!s.holidays.includes(workDate);
 return {workDate,dow,ready:s.subscribed&&due&&!quiet&&!onLeave&&working,reason:!s.subscribed?'Subscription off':onLeave?'Approved leave day':!working?'Non-working day':quiet?'Quiet hours':!due?'Scheduled time not reached':'Ready',timezone:s.timezone,dueTime,overnight};
}
