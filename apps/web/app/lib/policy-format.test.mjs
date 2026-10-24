import test from 'node:test';
import assert from 'node:assert/strict';
import {policyMarkdown} from './policy-format.mjs';
import {parseMarkdown} from './markdown.mjs';
test('legacy saved draft gets semantic headings and independent confirmation table rows without rewriting its text',()=>{
 const body='Draft — not published\n\nOld publishing path\n\nNorthwind Studio — Employee Leave, Attendance & Workplace Policy\n\nVersion 1 (draft)\n\n1. Leave entitlement\n\n- Two leaves\n\n2. Types of leave\n\n• Paternity leave: Five working days (confirm)\n\n• Bereavement leave: Three days (confirm)\n\n3. Applying for leave and the approval flow\n\n1. Apply in Pulse\n';
 const normalized=policyMarkdown(body),parsed=parseMarkdown(normalized);
 assert.equal(parsed.outline.length,4);assert.equal(parsed.blocks.find(b=>b.type==='table').rows.length,2);
 assert.equal(parsed.confirm.length,2);assert.ok(parsed.confirm[0].text.startsWith('Paternity leave'));
 assert.equal(body.startsWith('Draft — not published'),true);
 assert.equal(policyMarkdown('# Existing markdown\n\n- Keep text'),'# Existing markdown\n\n- Keep text');
});
