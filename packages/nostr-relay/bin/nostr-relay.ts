#!/usr/bin/env node
/**
 * In-memory NOSTR relay entry point
 * Run with: npm run dev | npm start | nostr-relay
 */

import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { inMemoryRelayLayer, program } from "../src/index.js"

NodeRuntime.runMain(program.pipe(Effect.provide(inMemoryRelayLayer)))
