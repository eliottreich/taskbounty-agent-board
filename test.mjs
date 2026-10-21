import { test } from "node:test";
import assert from "node:assert/strict";
import { createBridge, MAX_BYTES } from "./bridge.mjs";

test("forwards tool arguments and optional token; negotiates remote protocol", async () => {
  const requests = [];
  const bridge = createBridge({ token: "private-token", fetcher: async (url, options) => {
    requests.push({ url, ...options });
    const message = JSON.parse(options.body);
    return Response.json({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize" ? { protocolVersion: "2025-06-18" } : { tools: [] } });
  } });
  await bridge({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "future" } });
  const result = await bridge({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "reply_to_thread", arguments: { body: "Hi" } } });
  assert.equal(result.id, 2);
  assert.equal(requests[1].headers["MCP-Protocol-Version"], "2025-06-18");
  assert.equal(requests[1].headers["X-Board-Token"], "private-token");
  assert.equal(JSON.parse(requests[1].body).params.arguments.body, "Hi");
});
test("notifications produce no RPC response or unnecessary HTTP request", async () => {
  const bridge = createBridge({ fetcher: () => { throw new Error("should not fetch"); } });
  assert.equal(await bridge({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
});
test("bounded responses and remote identity mismatch fail safely", async () => {
  for (const response of [new Response("x".repeat(MAX_BYTES + 1)), Response.json({ jsonrpc: "2.0", id: 99, result: {} })]) {
    const result = await createBridge({ fetcher: async () => response })({ jsonrpc: "2.0", id: 1, method: "ping" });
    assert.equal(result.error.code, -32000);
  }
});
test("HTTP rate limits preserve retry hint without exposing credentials", async () => {
  const result = await createBridge({ fetcher: async () => new Response("private", { status: 429, headers: { "Retry-After": "60" } }) })({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.match(result.error.message, /retry after 60/);
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test('new identities are retained per bridge, while explicit worker tokens do not replace the default', async () => {
  const issued = 'a'.repeat(64), worker = 'b'.repeat(64), saved = [], headers = [];
  const bridge = createBridge({ onIdentity: async token => saved.push(token), fetcher: async (_, options) => {
    headers.push(options.headers); const m = JSON.parse(options.body);
    return Response.json({jsonrpc:'2.0',id:m.id,result:{structuredContent:{identity_token:m.params?.arguments?.identity_token || options.headers['X-Board-Token'] || issued}}});
  }});
  await bridge({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'coordinate_swarm',arguments:{action:'create'}}});
  await bridge({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'coordinate_swarm',arguments:{action:'join',identity_token:worker}}});
  await bridge({jsonrpc:'2.0',id:3,method:'ping'});
  const generated=headers[0]['X-Board-Token'];assert.match(generated,/^[a-f0-9]{64}$/);assert.equal(headers[1]['X-Board-Token'],worker);assert.equal(headers[2]['X-Board-Token'],generated);assert.deepEqual(saved,[generated]);
});
test('identity persistence failure does not turn a successful remote write into a failed write', async () => {
  let warned = false;
  const bridge=createBridge({onIdentity:async()=>{throw Error('private path');},onPersistenceError:()=>{warned=true;},fetcher:async()=>Response.json({jsonrpc:'2.0',id:1,result:{structuredContent:{identity_token:'a'.repeat(64)}}})});
  const r=await bridge({jsonrpc:'2.0',id:1,method:'tools/call'});assert.ok(r.result);assert.ok(warned);
});
test('identity files are private, survive restart, and reject shared/symlink files', async () => {
  const {mkdtemp,chmod,symlink,rm,stat}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {loadIdentity,saveIdentity}=await import('./identity.mjs');
  const dir=await mkdtemp(join(tmpdir(),'tb-board-identity-'));const file=join(dir,'worker.token');
  try {
    assert.equal(await loadIdentity(file),undefined);await saveIdentity(file,'a'.repeat(64));assert.equal(await loadIdentity(file),'a'.repeat(64));assert.equal((await stat(file)).mode&0o077,0);await saveIdentity(file,'a'.repeat(64));await assert.rejects(()=>saveIdentity(file,'b'.repeat(64)));
    const link=join(dir,'symlink');await symlink(file,link);await assert.rejects(()=>loadIdentity(link));await chmod(file,0o644);await assert.rejects(()=>loadIdentity(file));
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('first-write identity survives an ambiguous network failure and exact retry', async () => {
 const seen=[];let attempt=0;const b=createBridge({fetcher:async(_,options)=>{seen.push(options.headers['X-Board-Token']);if(++attempt===1)throw Error('network');return Response.json({jsonrpc:'2.0',id:1,result:{structuredContent:{identity_token:seen.at(-1)}}});}});
 const m={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'coordinate_swarm',arguments:{action:'create',name:'test',goal:'test',idempotency_key:'unique'}}};
 assert.ok((await b(m)).error);assert.ok((await b(m)).result);assert.match(seen[0],/^[a-f0-9]{64}$/);assert.equal(seen[0],seen[1]);
});
