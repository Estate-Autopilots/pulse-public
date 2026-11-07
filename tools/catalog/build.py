#!/usr/bin/env python3
"""Build the integrated catalog and offline browser; only Python's standard library is required."""
import argparse, collections, csv, hashlib, json, pathlib, re, runpy
ROOT = pathlib.Path(__file__).resolve().parents[2]
CAT = ROOT / 'docs/catalog'
HERE = pathlib.Path(__file__).parent
PHASES = ['MVP', 'P1 pilot', 'P2', 'P3', 'P4', 'Later']
NAMES = ['Platform core and admin','People and HR','Work sensing and tracking','Performance, quality and coaching','Projects and operations','Files and assets','Communication','Marketing, leads and outcomes','Analytics, reporting and AI','Apps and experience','Finance and business admin','Real-estate intelligence and expansion']
def full(s): return s if s.startswith('PUL-') else 'PUL-' + s
def write_csv(path, rows, fields):
    with path.open('w', newline='') as f:
        w=csv.DictWriter(f, fieldnames=fields, lineterminator='\n'); w.writeheader(); w.writerows(rows)
def source_ref(v):
    content=(CAT/v['module']/'features.md').read_text()
    match=re.search(r'^#{1,6} ('+re.escape(v['id'])+r'.*)$',content,re.M)
    if not match: return v['module']+'/features.md'
    heading=match.group(1).lower()
    anchor=re.sub(r'[^\w\- ]','',heading).replace(' ','-')
    return v['module']+'/features.md#'+anchor

def personas(raw):
    names=set()
    for token in re.split('[;,]',raw):
        x=token.strip().lower()
        if not x: continue
        if any(w in x for w in ['all staff','all authorized','employee','power user','disabled user','keyboard-only','peer','new hire']): names.add('Employee')
        if any(w in x for w in ['editor','creator','maker']): names.add('Editor')
        if any(w in x for w in ['designer','creator','maker']): names.add('Designer')
        if any(w in x for w in ['pgs','pod','project lead','direct manager','manager','lead']): names.add('Manager / PGS')
        if x=='hr' or x.startswith('hr ') or x in ['candidate','hiring manager','interviewer','people coordinator']: names.add('HR / Hiring')
        if any(w in x for w in ['leader','owner','commercial','agency']): names.add('Leadership / Owner')
        if x=='it' or any(w in x for w in ['admin','security','engineer','integrator','operator','tool owner','support','translator']): names.add('Admin / Operator')
        if any(w in x for w in ['analyst','data scientist','data steward','research','model reviewer']): names.add('Analyst / Researcher')
        if any(w in x for w in ['finance','payroll','expense','spend','pricing','auditor']): names.add('Finance / Payroll')
        if any(w in x for w in ['privacy']): names.add('Privacy officer')
        if any(w in x for w in ['client','developer marketing']): names.add('Client')
        if any(w in x for w in ['strategist','marketer','sme']): names.add('Marketing / Strategy')
        if any(w in x for w in ['sales','caller']): names.add('Sales')
        if any(w in x for w in ['coordinator','operations','field','videographer','freelancer']): names.add('Operations / Field')
        if any(w in x for w in ['reviewer','mentor','trainer','qc','approver']): names.add('Reviewer / Mentor')
    return ';'.join(sorted(names or {'Employee'}))

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--html-output', type=pathlib.Path, default=CAT/'pulse-catalog.html'); args=ap.parse_args()
    runpy.run_path(str(HERE/'write_workflows.py'))
    cfg=json.loads((HERE/'integration.json').read_text()); points=cfg['effort_points']; raw=[]; modules=[]
    for n,d in enumerate(sorted(CAT.glob('[0-9][0-9]-*'))):
        assert all((d/f).is_file() for f in ['research.md','features.md','features.csv','workflows.md','phasing.md']),d
        rs=list(csv.DictReader((d/'features.csv').open()))
        for r in rs: r['module']=d.name; raw.append(r)
        modules.append({'slug':d.name,'name':NAMES[n], 'source_count':len(rs)})
    assert len(modules)==12
    byid={r['id']:r for r in raw}; assert len(byid)==len(raw)
    aliases={k:k for k in byid}
    for group in cfg['merge_groups']:
        ids=[full(s) for s in group.split()]
        assert all(k in byid for k in ids),ids
        assert all(aliases[k]==k for k in ids),ids
        for k in ids: aliases[k]=ids[0]
    grouped=collections.defaultdict(list)
    for r in raw: grouped[aliases[r['id']]].append(r)
    rows=[]; overrides={full(k):v for k,v in cfg['phase_overrides'].items()}; active={full(k) for k in cfg['mvp']}
    for k,variants in grouped.items():
        owner=byid[k]; r=owner.copy(); phase=r['phase']; module=r['module']
        if phase=='MVP' and k not in active: phase='P1 pilot'
        if module.startswith(('06-','08-')) and phase in ['MVP','P1 pilot']: phase='P2'
        if module.startswith('07-') and phase=='P1 pilot' and int(k[-3:])<136: phase='P2'
        if module.startswith(('11-','12-')) and phase in ['MVP','P1 pilot','P2']: phase='P3'
        phase=overrides.get(k,phase)
        if k in active: phase='MVP'
        r['phase']=phase
        r['related']=';'.join(sorted({v['module'] for v in variants}-{module}))
        r['aliases']=';'.join(v['id'] for v in variants if v['id']!=k)
        r['source_phases']=';'.join(v['id']+':'+v['phase'] for v in variants)
        r['effort']=max((v['effort'] for v in variants),key=lambda s:points[s])
        r['effort_points']=points[r['effort']];r['score']=round(int(r['value'])/r['effort_points'],3)
        r['source_refs']=';'.join(source_ref(v) for v in variants)
        r['research_refs']=';'.join(v['module']+'/research.md' for v in variants)
        r['sources']=' | '.join(v['id']+': '+v['sources'] for v in variants)
        r['variant_details']=' | '.join(v['id']+' '+v['name']+': '+v['summary'] for v in variants if v['id']!=k)
        r['persona_notes']=';'.join(sorted({p.strip() for v in variants for p in re.split('[;,]',v['persona']) if p.strip()}))
        r['persona']=personas(r['persona_notes'])
        r['surface']=';'.join(sorted({p.strip().lower() for v in variants for p in re.split('[;,/]',v['surface']) if p.strip()}))
        # Canonical owner owns execution dependencies; UI aliases do not add a reverse implementation dependency.
        r['dependency_notes']=owner['depends_on']
        ids=re.findall(r'PUL-[A-Z]+-\d{3}',owner['depends_on']);missing=[i for i in ids if i not in aliases]
        assert not missing,(k,missing)
        deps={aliases[i] for i in ids}-{k}
        adjustment=cfg.get('dependency_overrides',{}).get(k.removeprefix('PUL-'),{})
        for old,new in adjustment.get('replace',{}).items():
            if aliases[full(old)] in deps: deps.remove(aliases[full(old)]);deps.add(aliases[full(new)])
        for old in adjustment.get('drop',[]):deps.discard(aliases[full(old)])
        r['depends_on']=';'.join(sorted(deps))
        services=set()
        dep=owner['depends_on'].lower()
        for words,service in [(['identity','iam','auth','tenant','rls','acl'],'iam'),(['event','ingest','projection'],'events'),(['privacy','purpose','consent','retention'],'privacy'),(['drive','connector','connect'],'connections'),(['notify','notification','telegram'],'notifications'),(['model','eval','explain','llm'],'evaluation'),(['media','scan','preview'],'media'),(['device','enrol'],'devices')]:
            if any(w in dep for w in words):services.add('core:'+service)
        r['core_services']=';'.join(sorted(services))
        r['disposition']='active-scope' if k in active else 'candidate'
        r['integration_note']=adjustment.get('reason','')
        if k=='PUL-TRK-195':
            r['disposition']='excluded';r['integration_note']='EST-55 says no cameras. Preserved for traceability; do not schedule.'
        if k in [full('COM-'+str(n).zfill(3)) for n in range(67,72)]:
            r['disposition']='conditional';r['integration_note']='Provider entitlement and supported group capability must be proven; arbitrary existing-group capture is unconfirmed. Otherwise Later.'
        if r['phase']!=owner['phase']:r['integration_note']+=(' ' if r['integration_note'] else '')+'Cross-module phase replaces the module suggestion; see PHASES.md.'
        rows.append(r)
    fields=list(raw[0])+['related','aliases','source_phases','effort_points','score','source_refs','research_refs','variant_details','dependency_notes','core_services','disposition','integration_note','persona_notes']
    master={r['id']:r for r in rows}
    for _ in range(len(rows)):
        changed=False
        for r in rows:
            needed=max([PHASES.index(r['phase'])]+[PHASES.index(master[d]['phase']) for d in r['depends_on'].split(';') if d])
            if needed>PHASES.index(r['phase']):
                assert r['disposition']!='active-scope', ('Active prerequisite needs explicit reconciliation',r['id'])
                r['phase']=PHASES[needed]; r['integration_note']+=' Scheduled after its canonical feature prerequisites.'; changed=True
        if not changed: break
    rows.sort(key=lambda r:r['id']);write_csv(CAT/'MASTER-FEATURES.csv',rows,fields)
    write_csv(CAT/'FEATURE-ALIASES.csv',[{'source_id':k,'canonical_id':v,'source_module':byid[k]['module'],'owner_module':byid[v]['module'],'reason':'Same capability; domain owner includes the other surfaces' if k!=v else 'Retained as distinct capability'} for k,v in sorted(aliases.items())],['source_id','canonical_id','source_module','owner_module','reason'])
    for m in modules:m['owned_count']=sum(r['module']==m['slug'] for r in rows);m['related_count']=sum(m['slug'] in r['related'].split(';') for r in rows)
    top=sorted((r for r in rows if r['disposition']!='excluded'),key=lambda r:(-r['score'],-int(r['value']),PHASES.index(r['phase']),r['id']))[:50]
    index='\n'.join(f"| [{m['name']}]({m['slug']}/research.md) | {m['source_count']} | {m['owned_count']} | {m['related_count']} | [features]({m['slug']}/features.md) · [workflows]({m['slug']}/workflows.md) · [phasing]({m['slug']}/phasing.md) |" for m in modules)
    tops='\n'.join(f"| {n} | {r['id']} | [{r['name']}]({source_ref(byid[r['id']])}) | {r['module'][:2]} | {r['value']} | {r['effort']} | {r['score']:g} | {r['phase']} |" for n,r in enumerate(top,1))
    readme=(HERE/'readme.md').read_text().replace('{{INDEX}}',index).replace('{{TOP50}}',tops).replace('{{RAW}}',str(len(raw))).replace('{{COUNT}}',str(len(rows))).replace('{{MERGED}}',str(len(raw)-len(rows)))
    (CAT/'README.md').write_text(readme)
    # Page equivalents count prose Markdown only; exclude CSV duplicate data, HTML/JS and build code.
    source_files=sorted(CAT.glob('[0-9][0-9]-*/*.md'))
    integrated_files=[CAT/n for n in ['README.md','PHASES.md','WORKFLOWS.md','PRIORITY-MENU.md']]
    counts=lambda fs:{str(f.relative_to(CAT)):len(f.read_text().split()) for f in fs}
    source_words=counts(source_files);integration_words=counts(integrated_files)
    dependency_lags=[]
    master={r['id']:r for r in rows}
    for r in rows:
        for dep in filter(None,r['depends_on'].split(';')):
            if PHASES.index(master[dep]['phase'])>PHASES.index(r['phase']):dependency_lags.append({'feature':r['id'],'dependency':dep,'feature_phase':r['phase'],'dependency_phase':master[dep]['phase']})
    stats={'date':cfg['date'],'raw_features':len(raw),'features':len(rows),'merged_rows':len(raw)-len(rows),'modules':modules,'phases':dict(collections.Counter(r['phase'] for r in rows)),'dispositions':dict(collections.Counter(r['disposition'] for r in rows)),'source_markdown_words':sum(source_words.values()),'source_page_equivalents':round(sum(source_words.values())/500,2),'integrated_markdown_words':sum(integration_words.values()),'integrated_page_equivalents':round(sum(integration_words.values())/500,2),'markdown_words':sum(source_words.values())+sum(integration_words.values()),'page_equivalents':round((sum(source_words.values())+sum(integration_words.values()))/500,2),'word_count_method':'Whitespace-delimited words in 60 source Markdown files plus README, PHASES, WORKFLOWS and PRIORITY-MENU; includes tables and Mermaid text; excludes CSV/HTML/build code/this receipt to avoid duplicate counting.','words_by_file':source_words|integration_words,'dependency_phase_conflicts':dependency_lags,'master_sha256':hashlib.sha256((CAT/'MASTER-FEATURES.csv').read_bytes()).hexdigest()}
    (CAT/'INTEGRATION-REPORT.json').write_text(json.dumps(stats,indent=2)+'\n')
    payload={'features':rows,'modules':modules,'stats':{k:v for k,v in stats.items() if k not in ['words_by_file','dependency_phase_conflicts']}}
    out=(HERE/'browser.html').read_text().replace('@@DATA@@',json.dumps(payload,ensure_ascii=False).replace('<','\\u003c').replace('\u2028','\\u2028').replace('\u2029','\\u2029'))
    args.html_output.parent.mkdir(parents=True,exist_ok=True);args.html_output.write_text(out)
    print(json.dumps({k:v for k,v in stats.items() if k not in ['words_by_file','modules','dependency_phase_conflicts']}));print('Dependency phase conflicts:',len(dependency_lags))
if __name__=='__main__':main()
