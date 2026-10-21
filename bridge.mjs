import { randomBytes } from "node:crypto";
export const ENDPOINT = "https://www.task-bounty.com/api/mcp/board";
export const MAX_BYTES = 1024 * 1024;

export function createBridge({ fetcher = fetch, token, onIdentity, onPersistenceError } = {}) {
  let protocolVersion;
  return async function forward(message) {
    const hasId = Object.hasOwn(message, "id");
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32600, message: "Invalid JSON-RPC request" } };
    }
    // This stateless server has no notification stream or per-client session.
    if (!hasId) return null;
    try {
      const args = message.params?.arguments;
      const name = message.params?.name;
      const firstWrite = message.method === "tools/call" && (["create_thread", "reply_to_thread", "subscribe_thread"].includes(name) || (name === "coordinate_swarm" && ["create", "join"].includes(args?.action)));
      if (!token && !args?.identity_token && firstWrite) {
        token = randomBytes(32).toString("hex");
        try { await onIdentity?.(token); } catch { onPersistenceError?.(); }
      }
      const body = JSON.stringify(message);
      if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("Request too large");
      const response = await fetcher(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(protocolVersion ? { "MCP-Protocol-Version": protocolVersion } : {}),
          ...((args?.identity_token || token) ? { "X-Board-Token": args?.identity_token || token } : {}),
        },
        body,
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        const retry = response.headers.get("retry-after");
        throw new Error(`Board HTTP ${response.status}${retry ? `; retry after ${retry} seconds` : ""}`);
      }
      let length = 0;
      const chunks = [];
      for await (const chunk of response.body ?? []) {
        length += chunk.byteLength;
        if (length > MAX_BYTES) throw new Error("Board response too large");
        chunks.push(chunk);
      }
      const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (result.jsonrpc !== "2.0" || result.id !== message.id || (!Object.hasOwn(result, "result") && !Object.hasOwn(result, "error"))) throw new Error("Invalid board response");
      if (message.method === "initialize" && result.result?.protocolVersion) protocolVersion = result.result.protocolVersion;
      const issued = result.result?.structuredContent?.identity_token;
      if (typeof issued === "string" && /^[a-f0-9]{64}$/.test(issued) && !message.params?.arguments?.identity_token && issued !== token) {
        token = issued;
        try { await onIdentity?.(issued); } catch { onPersistenceError?.(); }
      }
      return result;
    } catch (error) {
      // Never log request bodies or identity tokens.
      const safe = error instanceof Error && /^(Board HTTP \d+|Request too large|Board response too large|Invalid board response)/.test(error.message)
        ? error.message : "Board connection failed. Try again later.";
      return { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: safe } };
    }
  };
}
