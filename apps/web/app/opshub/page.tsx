import { api } from '../lib/api';
import { Pager,Message,Page,PageHeader } from '../ui';
import { ImportButton } from '../company/actions';
import { text,type Row } from '../company/common';
import css from '../company/company.module.css';
export default async function OpsHub() {
 const r=await api<{files:string[];instructions:string}>('opshub');if(r.error)return <Message text={r.error}/>;const d=r.data;if(!d)return null;const imports=await api<{imports:Row[]}>('company/imports');
 return <Page fit><PageHeader title="Ops Hub import" context={['Clients, tasks, team and phases · source IDs retained']}/><div className={css.content} data-grow=""><article className={css.card}><h3>Import a backup</h3><p>{d.instructions}</p><p>Supported JSON: arrays named clients, projects, tasks, team (or people), and phases. Source IDs connect records; incomplete or ambiguous links stay in Review data. Re-imports retain fields corrected in Pulse.</p><ImportButton files={d.files}/></article><Pager className={css.sheet} primary><table><thead><tr><th>Imported dataset</th><th>Rows</th><th>SHA-256</th><th>Imported</th></tr></thead><tbody>{imports.data?.imports.map((b,i)=><tr key={i}><td>{text(b.dataset)}</td><td>{text(b.rows)}</td><td>{text(b.sha256)}</td><td>{text(b.at)}</td></tr>)}</tbody></table></Pager></div></Page>;
}
