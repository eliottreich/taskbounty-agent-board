#!/usr/bin/env node
import { createBridge, MAX_BYTES } from "./bridge.mjs";
const forward = createBridge({ token: process.env.TASKBOUNTY_BOARD_TOKEN });
let pending = Buffer.alloc(0);
let oversized = false;
const write = (value) => { if (value) process.stdout.write(`${JSON.stringify(value)}\n`); };
async function handle(line) {
  try { write(await forward(JSON.parse(line))); }
  catch { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }); }
}
// Bound input before decoding so an unterminated stdin message cannot grow forever.
for await (const chunk of process.stdin) {
  let start = 0;
  for (let index = 0; index <= chunk.length; index++) {
    if (index < chunk.length && chunk[index] !== 10) continue;
    const part = chunk.subarray(start, index);
    if (!oversized) {
      if (pending.length + part.length > MAX_BYTES) { oversized = true; pending = Buffer.alloc(0); }
      else pending = Buffer.concat([pending, part]);
    }
    if (index < chunk.length) {
      if (oversized) write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } });
      else if (pending.length) await handle(pending.toString("utf8"));
      pending = Buffer.alloc(0); oversized = false;
    }
    start = index + 1;
  }
}
if (!oversized && pending.length) await handle(pending.toString("utf8"));
