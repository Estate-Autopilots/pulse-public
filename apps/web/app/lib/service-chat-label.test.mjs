// Render the existing conversation bubble, isolated from its browser-only siblings. No product UI changes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import React, { useState, useRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { clock, segments, ticks } from './chat-format.mjs';

// The real kit badge (its tooltip reduced to its trigger), so the bubble renders the shipped marker.
const require = createRequire(import.meta.url), kit = {exports:{}};
runInNewContext(ts.transpileModule(readFileSync(new URL('../kit/ai-badge.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,
  {module:kit,exports:kit.exports,require:name => name.endsWith('.css') ? {__esModule:true,default:new Proxy({},{get:(_,key)=>key})} : name === './popover' ? {Tooltip:({children})=>children} : require(name)});
const source = readFileSync(new URL('../chats/conversation.tsx',import.meta.url),'utf8');
const ast = ts.createSourceFile('conversation.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
// CHAT-V3 (ace286e5): Bubble is `const Bubble = memo(function Bubble(...) {...}, same)`; render the inner function.
const decl = ast.statements.filter(ts.isVariableStatement).flatMap(n => n.declarationList.declarations).find(d => d.name.getText(ast) === 'Bubble');
const bubble = decl && ts.isCallExpression(decl.initializer) ? decl.initializer.arguments[0] : ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'Bubble');
assert.ok(bubble);
const js = ts.transpileModule(`const Bubble = ${bubble.getText(ast)}`,{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022}}).outputText;
const empty = () => null;
// What the label check needs is real (React, the kit badge, links, text segments); every other component, icon and
// helper the bubble grows is a stub that renders nothing, so new siblings do not break this isolated render.
const deps = {React,useState,useRef,css:new Proxy({},{get:(_,key)=>key}),v3:new Proxy({},{get:(_,key)=>key}),wk:new Proxy({},{get:(_,key)=>key}),clock,segments,ticks,
  hue:()=>1,isImage:()=>false,isVoice:()=>false,coarse:()=>false,AiBadge:kit.exports.AiBadge,
  Avatar:({id}) => React.createElement('span',{'data-avatar':id}),
  Link:({prefetch,children,...props}) => React.createElement('a',props,children)};
const scope = new Proxy(deps,{has:(_,key) => typeof key === 'string' && !(key in globalThis),get:(target,key) => key in target ? target[key] : empty});
const Bubble = new Function('scope',`with (scope) { ${js}; return Bubble; }`)(scope);
const render = (m, props = {}) => renderToStaticMarkup(React.createElement(Bubble,{m,mine:false,group:true,run:false,usernames:[],viewer:'human',myName:null,tick:null,cards:new Map(),note:undefined,transcripts:false,channel:{id:'chat'},flash:false,api:{actions:()=>[]},...props}));
const senderMessage = {id:'synthetic-message',authorId:'synthetic-person',name:'Synthetic Person',body:'Release ready',createdAt:'2026-10-18T10:00:00Z',attachments:[],reactions:[]};

test('group message avatars and sender names link to the sender profile', () => {
  const html = render(senderMessage);
  assert.match(html, /<a href="\/people\/synthetic-person"[^>]*aria-label="Open Synthetic Person’s profile"[^>]*><span data-avatar="synthetic-person"><\/span><\/a>/);
  assert.match(html, /<a href="\/people\/synthetic-person">Synthetic Person<\/a>/);
  const ai = render({...senderMessage,byAgent:true});
  assert.match(ai, /<a href="\/people\/ai\/synthetic-person"[^>]*aria-label="Open Synthetic Person’s profile"/);
  assert.match(ai, /<a href="\/people\/ai\/synthetic-person">Synthetic Person<\/a>/);
});

test('WhatsApp guests have no profile link and consecutive messages keep their avatar gap', () => {
  const guest = render({...senderMessage,guest:true});
  assert.match(guest, /data-avatar="synthetic-person"/);
  assert.doesNotMatch(guest, /href="\/people\//);
  const consecutive = render(senderMessage,{run:true});
  assert.match(consecutive, /class="avatarGap"/);
  assert.doesNotMatch(consecutive, /href="\/people\//);
});

test('a post-only AI message shows the AI badge without an agent run', () => {
  const message = {id:'synthetic-message',authorId:'synthetic-agent',name:'Synthetic Updates',body:'Release ready',createdAt:'2026-10-18T10:00:00Z',attachments:[],reactions:[],byAgent:true};
  const ai = render(message), human = render({...message,byAgent:false});
  assert.match(ai,/role="img" aria-label="AI employee"/);
  assert.match(ai,/<a href="\/people\/ai\/synthetic-agent">Synthetic Updates<\/a>/);
  assert.doesNotMatch(human,/aria-label="AI employee/);
  assert.doesNotMatch(human,/\/people\/ai\//);
});
