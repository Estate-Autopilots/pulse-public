'use client';
import {useState} from 'react';
import {Modal} from '../../records';
import {styles,Badge} from '../../ui';
import type {Assertion} from '../../clients/master-types';
import css from '../../intelligence/intelligence.module.css';
export function ContactEvidence({name,assertions}:{name:string;assertions:Assertion[]}){
 const[open,setOpen]=useState(false);
 return <><button className={styles.btn} onClick={()=>setOpen(true)}>{assertions.length} receipts</button>{open?<Modal min={1} title={`Selected evidence · ${name}`} onClose={()=>setOpen(false)}><div className={css.items}>{assertions.length?assertions.map(a=><article key={a.id} className={css.card}><h4>{a.kind} · {a.value}</h4><Badge>{a.verified?'Verified':'Unverified'}</Badge><p>{a.shared?'Shared identifier; context only.':'Selected identity assertion.'}</p><p>Scope · {a.source_scope}<br/>Independent family · {a.source_family}<br/>Receipt · {a.source_ref}</p></article>):<article className={css.card}><h4>No selected source evidence</h4><p>A name alone never matches. Choose a resolvable source receipt before asserting an identifier.</p></article>}</div></Modal>:null}</>;
}
