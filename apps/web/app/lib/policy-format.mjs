/** Presentation adapter for the policy saved as plain text before the Markdown editor existed.
 * It never writes the document. The redundant review preface is replaced by the reader's current status and
 * publish sheet; confirmation questions are collected from the actual policy sections, one table row at a time. */
export function policyMarkdown(body) {
 const source=String(body??'');
 const titleMatch=source.match(/^([^\n]+ — Employee Leave, Attendance & Workplace Policy)$/m);
 if(!source.startsWith('Draft — not published\n')||!titleMatch)return source;
 const title=titleMatch[1];
 let text=source.slice(source.indexOf('\n'+title+'\n')+1);
 const headings=['Leave entitlement','Types of leave','Applying for leave and the approval flow','Attendance and working hours','Working on a weekly off, holiday or at night','Holidays','Salary, payslips and Professional Tax','Confidentiality and data protection','Prevention of Sexual Harassment (POSH)','Social media and public communication','Workplace respect and conduct','Notice period and exit','Recognition','About this policy'];
 text=text.replace(title,'# '+title);
 headings.forEach((heading,i)=>{text=text.replace('\n'+(i+1)+'. '+heading+'\n','\n## '+(i+1)+'. '+heading+'\n');});
 const from=text.indexOf('## 2. Types of leave\n'),to=text.indexOf('## 3. Applying for leave');
 if(from>=0&&to>from){const lines=text.slice(from,to).split('\n');const rows=lines.filter(l=>l.startsWith('• ')).map(l=>{const split=l.indexOf(':');return '| '+l.slice(2,split).replaceAll('|','\\|')+' | '+l.slice(split+1).trim().replaceAll('|','\\|')+' |';});
 if(rows.length)text=text.slice(0,from)+'## 2. Types of leave\n\n| Type | How it works |\n| --- | --- |\n'+rows.join('\n')+'\n\n'+text.slice(to);
 }
 return text.replace(/^• /gm,'- ');
}
