import json,pathlib,csv
p=pathlib.Path(__file__).resolve().parents[2];cfg=json.loads((p/'tools/catalog/integration.json').read_text());alias={}
for group in cfg['merge_groups']:
 ids=group.split()
 for x in ids:alias[x]=ids[0]
lines=['# The 30 most important end-to-end workflows','', 'These journeys connect the modules around an owner or employee outcome. They are proposed implementation contracts, not claims that the whole journey exists today. Phase spans mean the minimal early slice can ship before its later automation. Each feature list uses canonical IDs; module source workflows supply the deeper screen and acceptance detail.','', 'Common release rule: enforce tenant, person, pod, client and purpose scope at the server; retain source/version receipts; make retries idempotent; show unknown, stale or failed states truthfully. Private employee evidence never enters client projections. External sending and provider writes require the authority described in that selected workflow.','']
rows=list(csv.reader((p/'tools/catalog/workflows.tsv').open(),delimiter='\t'));assert len(rows)==30
for n,r in enumerate(rows,1):
 title,phase,actors,trigger,ids,steps,data,failure,accept=r;ids=list(dict.fromkeys('PUL-'+alias.get(x,x) for x in ids.split()));path=steps.split('; ')
 lines += [f'## W{n:02d} · {title}', '', f'**Phase:** {phase}. **Actors:** {actors}. **Trigger:** {trigger}.', '', '**Handoffs:**', '']
 lines += [f'{i}. {s[0].upper()+s[1:]}.' for i,s in enumerate(path,1)]
 lines += ['',f'**Data and receipts:** {data}.', '', f'**Failure and recovery:** {failure}', '', f'**Acceptance:** {accept}', '', '**Features:** '+', '.join(ids)+'.', '', '```mermaid', 'flowchart LR', f'  A["{path[0].replace(chr(34),chr(39))}"] --> B["{path[1].replace(chr(34),chr(39))}"]', f'  B --> C["{path[-1].replace(chr(34),chr(39))}"]', '  B --> E["Visible exception and accountable recovery"]', '```','']
(p/'docs/catalog/WORKFLOWS.md').write_text('\n'.join(lines))
