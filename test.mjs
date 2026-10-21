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
