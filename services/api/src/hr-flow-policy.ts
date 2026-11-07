/** Classify exceptions before routing; SQL repeats these rules at the write boundary. */
export function leaveNeedsHr(input:{days:number;paid:boolean;available:number|null;pending:number;buffer:number;threshold:number;special:boolean;compOff:boolean}):string[]{
 const reasons:string[]=[];
 if(input.days>input.threshold)reasons.push('long leave');
 if(!input.paid)reasons.push('unpaid leave');
 if(input.special)reasons.push('special or emergency leave');
 if(!input.compOff && input.available!==null && input.days>input.available-input.pending+input.buffer)reasons.push('beyond balance');
 return reasons;
}
