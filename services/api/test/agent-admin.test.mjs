import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile), id = '00000000-0000-0000-0000-0000000000a1';
test('agent-admin sends the operator request on loopback and emits only two UUIDs', async () => {
  let received, headers;
  const server = createServer(async (req,res) => {
    const parts=[]; for await (const part of req) parts.push(part);
    received=JSON.parse(Buffer.concat(parts)); headers=req.headers;
    assert.equal(req.url,'/api/v1/operator/agent-chat'); assert.equal(req.method,'POST');
    res.setHeader('content-type','application/json'); res.end(JSON.stringify({agentId:id,chatId:id}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const env={...process.env,PULSE_OPERATOR_URL:`http://127.0.0.1:${server.address().port}`,PULSE_OPERATOR_TOKEN:'synthetic-operator-token-0123456789abcdef'};
  delete env.PULSE_OPERATOR_TOKEN_FILE;
  const args=['chat','--name','Pulse Updates','--username','pulse-updates','--chat','Studio updates','--members','one@studio.example,two@studio.example'];
  const run=(argv=args,extra={})=>exec(process.execPath,[new URL('../dist/agent-admin.js',import.meta.url).pathname,...argv],{env:{...env,...extra}});
  try {
    const result=await run(); assert.equal(result.stdout,`${id} ${id}\n`); assert.equal(result.stderr,'');
    assert.deepEqual(received,{name:'Pulse Updates',username:'pulse-updates',chat:'Studio updates',members:['one@studio.example','two@studio.example']});
    assert.equal(headers.authorization,`Bearer ${env.PULSE_OPERATOR_TOKEN}`);
    for (const [argv,extra] of [[args,{PULSE_OPERATOR_URL:'https://outside.example'}],[[...args,'--name','duplicate'],{}]]) {
      await assert.rejects(run(argv,extra), error=>error.code===1 && error.stdout==='' && !error.stderr.includes(env.PULSE_OPERATOR_TOKEN));
    }
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
