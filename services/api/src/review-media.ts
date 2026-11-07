export function parseRange(value:string|undefined,size:number):{start:number;end:number;partial:boolean}|null{
 if(!Number.isSafeInteger(size)||size<=0)return null;if(!value)return {start:0,end:size-1,partial:false};const match=/^bytes=(\d*)-(\d*)$/.exec(value);if(!match||!match[1]&&!match[2])return null;
 let start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2])),end=match[1]?(match[2]?Math.min(size-1,Number(match[2])):size-1):size-1;
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start||!match[1]&&Number(match[2])===0)return null;
 return {start,end,partial:true};
}
