import test from 'node:test';import assert from 'node:assert/strict';
import {sanitizeEmailHtml,linkLabel,unwrapLink,parseSender,describeLabels,inboxQuery,safeCss,hasMailbox} from '../dist/email-model.js';

test('scripts, handlers, forms, frames and javascript: links never survive',()=>{
 const {html}=sanitizeEmailHtml(`<div onclick="steal()">Hi<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a><a href="jav&#x61;script:alert(2)">y</a>
  <iframe src="https://evil.test"></iframe><form action="https://evil.test"><input name=a><button>Go</button></form><svg><script>1</script></svg><object data=x></object><meta http-equiv=refresh content="0;url=https://evil.test"><base href="https://evil.test"></div>`);
 for(const bad of ['script','onclick','onerror','javascript','iframe','<form','<input','<button','<svg','<object','<meta','<base','evil.test'])assert.ok(!html.toLowerCase().includes(bad),bad+' in '+html);
 assert.ok(html.includes('Hi'));
});
test('newsletter layout stays: tables, inline styles, style blocks without imports or expressions',()=>{
 const {html}=sanitizeEmailHtml('<style>@import url(https://x.test/a.css);.a{color:red;width:expression(alert(1))}</style><table width="600" cellpadding="0"><tr><td style="background:url(javascript:alert(1));padding:8px" class="a">Cell</td></tr></table>');
 assert.match(html,/<table width="600" cellpadding="0"><tr><td style="[^"]*padding:8px" class="a">Cell<\/td><\/tr><\/table>/);
 assert.ok(!/@import|expression\(|javascript/i.test(html));
 assert.equal(safeCss('position: fixed; top:0'),'position:static; top:0');
});
test('remote images are counted for "show images"; data and inline (cid) images map; links open in a new tab',()=>{
 const r=sanitizeEmailHtml('<img src="https://track.example.com/open.gif"><img src="data:image/png;base64,AAAA"><img src="cid:logo@x"><a href="https://example.com/a">here</a>',id=>id==='logo@x'?'/api/v0/inbox/attachment?cid=1':null);
 assert.equal(r.remoteImages,1);assert.equal(r.links,1);
 assert.ok(r.html.includes('src="/api/v0/inbox/attachment?cid=1"'));assert.ok(r.html.includes('data:image/png;base64,AAAA'));
 assert.ok(r.html.includes('target="_blank" rel="noopener noreferrer"'));
});
test('a tracking URL shown as link text becomes its domain; wrappers unwrap',()=>{
 const long='https://click.mailer.example.com/ls/click?upn=u001.Qx7Xj-2BzYhW3k9-2FcV8aLqPZ-2Bq4kD0Hn5aL3dYp-2Fq&_ga=1';
 const {html}=sanitizeEmailHtml(`<p><a href="${long}">${long}</a></p>`);
 assert.ok(html.includes('>mailer.example.com</a>'),html);
 assert.equal(linkLabel('https://www.google.com/url?q=https://docs.example.org/x&sa=D'),'docs.example.org');
 assert.equal(unwrapLink('https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fexample.net%2Fpath&data=1'),'https://example.net/path');
 assert.equal(linkLabel('mailto:priya@example.com'),'priya@example.com');
});
test('quoted earlier messages collapse behind one control',()=>{
 const gmail=sanitizeEmailHtml('<div>Thanks!</div><div class="gmail_quote"><div>On Mon, X wrote:</div><blockquote class="gmail_quote">Old <b>text</b></blockquote></div><p>After</p>').html;
 assert.equal((gmail.match(/<details/g)??[]).length,1);
 assert.match(gmail,/^<div>Thanks!<\/div><details class="pulse-quote"><summary[^>]*>•••<\/summary><div class="gmail_quote">.*<\/div><\/details><p>After<\/p>$/);
 const outlook=sanitizeEmailHtml('<div><p>Reply</p><div id="divRplyFwdMsg"><b>From:</b> A</div><div>Original</div></div><p>tail</p>').html;
 assert.match(outlook,/<p>Reply<\/p><details class="pulse-quote">.*Original<\/div><\/details><\/div><p>tail<\/p>/);
 assert.match(sanitizeEmailHtml('<blockquote type="cite">x</blockquote>').html,/^<details/);
});
test('broken markup closes cleanly and stray angle brackets stay text',()=>{
 const {html}=sanitizeEmailHtml('<div><p>a < b and <b>bold</div> tail <unknown>kept</unknown>');
 assert.equal(html,'<div><p>a &lt; b and <b>bold</b></p></div> tail kept');
});
test('senders, labels and the Gmail query for a view',()=>{
 assert.deepEqual(parseSender('"Priya Soniba" <Priya@Example.com>'),{name:'Priya Soniba',email:'priya@example.com'});
 assert.deepEqual(parseSender('noreply@example.com'),{name:'noreply',email:'noreply@example.com'});
 const d=describeLabels(['INBOX','UNREAD','CATEGORY_PROMOTIONS','Label_7','STARRED'],new Map([['Label_7','Clients/Acme']]));
 assert.deepEqual(d,{category:'promotions',labels:['Clients/Acme'],starred:true,important:false});
 assert.equal(inboxQuery({category:'primary',unread:'1'}),'in:inbox -category:promotions -category:social -category:updates -category:forums is:unread');
 assert.equal(inboxQuery({category:'social'}),'in:inbox category:social');
 assert.equal(inboxQuery({q:'invoice',category:'primary'}),'invoice');
 assert.equal(inboxQuery({label:'Clients/"Acme"'}),'label:"Clients/Acme"');
 assert.equal(inboxQuery({starred:'1'}),'is:starred');
});
test('UI-POLISH-3 (R024): a synthetic .invalid address has no mailbox to warm or read',()=>{
 assert.equal(hasMailbox('synthetic.member@synthetic.invalid'),false);
 assert.equal(hasMailbox('Synthetic.Member@Example.INVALID '),false);
 assert.equal(hasMailbox(''),false);assert.equal(hasMailbox(null),false);assert.equal(hasMailbox('not-an-address'),false);
 assert.equal(hasMailbox('synthetic.member@example.com'),true);
});
