import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const rust=readFileSync(new URL('../src-tauri/src/appwin.rs',import.meta.url),'utf8');
const init=/const INIT: &str = r#"([\s\S]*?)"#;/u.exec(rust)?.[1];
assert.ok(init,'Test the exact script injected by the native window');

function page({platform='MacIntel',field=null,hash='',protocol='https:',hostname='pulse.estateautopilots.com'}={}){
  let mutation,disconnected=false;
  const listeners={};
  const location={href:'/dashboard',hash,protocol,hostname};
  const context={window:{},navigator:{platform},location,history:{back(){},forward(){}},
    document:{documentElement:{classList:{add(){}}},readyState:'complete',querySelector:()=>field,addEventListener(){}},
    addEventListener:(event,fn)=>{listeners[event]=fn;},
    MutationObserver:class {constructor(fn){mutation=fn;}observe(){}disconnect(){disconnected=true;}},
    setTimeout(){},
  };
  vm.runInNewContext(init,context);
  return {context,listeners,setField:(next)=>{field=next;mutation?.();},disconnected:()=>disconnected};
}

test('Cmd+K and Ctrl+K focus and select the existing view search',()=>{
  for(const platform of ['MacIntel','Win32']){
    let focused=0,selected=0,prevented=0;
    const p=page({platform,field:{focus(){focused++;},select(){selected++;}}});
    p.listeners.keydown({key:'k',metaKey:platform==='MacIntel',ctrlKey:platform==='Win32',altKey:false,preventDefault(){prevented++;}});
    assert.equal(focused,1);assert.equal(selected,1);assert.equal(prevented,1);
    assert.equal(p.context.location.href,'/dashboard');
  }
});

test('a view with no search opens People and focuses its field after render',()=>{
  const p=page();p.context.window.__pulseApp.search();
  assert.equal(p.context.location.href,'/people#pulse-search');
  let focused=0,selected=0;
  const landing=page({hash:'#pulse-search'});
  landing.setField({focus(){focused++;},select(){selected++;}});
  assert.equal(focused,1);assert.equal(selected,1);assert.equal(landing.disconnected(),true);
});

test('search keeps the native sign-in and offline screen on a local page',()=>{
  for(const options of [{protocol:'tauri:',hostname:'localhost'},{protocol:'http:',hostname:'tauri.localhost'}]){
    const p=page(options);p.context.window.__pulseApp.search();
    assert.equal(p.context.location.href,'/dashboard');
  }
});
