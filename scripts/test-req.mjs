#!/usr/bin/env node
/**
 * Quick test: connect to relay, send REQ, print responses.
 * Run relay first: RELAY_PORT=8182 npm run dev
 * Then: node scripts/test-req.mjs
 */
import WebSocket from "ws"
const ws = new WebSocket("ws://localhost:8182")
ws.on("open", () => {
  ws.send(JSON.stringify(["REQ", "test", { kinds: [1], limit: 5 }]))
})
ws.on("message", (data) => console.log("<-", data.toString()))
ws.on("error", (e) => console.error("Error", e))
ws.on("close", (code) => process.exit(code === 1005 ? 0 : 1))
setTimeout(() => ws.close(), 3000)
