/**
 * Effect services and layers for the NOSTR relay
 */

import { Config, Effect, Layer, ServiceMap } from "effect"
import type { SocketError } from "effect/unstable/socket/Socket"
import { HEX64 } from "./constants.js"
import type { NostrEvent, NostrFilter } from "./schema.js"

const RelayConfigSchema = Config.all({
  port: Config.number("RELAY_PORT").pipe(Config.withDefault(() => 8181)),
  host: Config.string("RELAY_HOST").pipe(Config.withDefault(() => "0.0.0.0")),
  /** Max seconds event created_at can differ from now (default 900 = 15 min) */
  createdAtWindowSec: Config.number("RELAY_CREATED_AT_WINDOW_SEC").pipe(Config.withDefault(() => 900)),
  /** Comma-separated 64-char hex pubkeys to ban (default empty) */
  bannedPubkeys: Config.string("RELAY_BANNED_PUBKEYS").pipe(
    Config.withDefault(() => ""),
    Config.map((s) =>
      new Set(
        s
          .split(",")
          .map((p) => p.trim().toLowerCase())
          .filter((p) => HEX64.test(p))
      )
    )
  )
})

/** Subscription entry for a connected client */
export interface SubEntry {
  readonly connKey: string
  readonly subId: string
  readonly send: (msg: string) => Effect.Effect<void, SocketError>
  readonly filters: NostrFilter[]
}

/** Composite key for subscription map: connKey + subId (null byte delimiter) */
export const subKey = (connKey: string, subId: string) => `${connKey}\x00${subId}`

/** RelayStore - in-memory event store and subscription registry */
export class RelayStore extends ServiceMap.Service<RelayStore, {
  readonly hasEvent: (id: string) => Effect.Effect<boolean>
  readonly storeEvent: (event: NostrEvent) => Effect.Effect<{ duplicate: boolean }>
  readonly getEvents: () => Effect.Effect<Map<string, NostrEvent>>
  readonly getSubs: () => Effect.Effect<Map<string, SubEntry>>
  readonly updateSubs: (
    fn: (m: Map<string, SubEntry>) => Map<string, SubEntry>
  ) => Effect.Effect<void>
  readonly updateEvents: (
    fn: (m: Map<string, NostrEvent>) => Map<string, NostrEvent>
  ) => Effect.Effect<void>
}>()("RelayStore") {}

/** RelayConfig - host, port, validation settings, and banned pubkeys */
export class RelayConfig extends ServiceMap.Service<RelayConfig, {
  readonly host: string
  readonly port: number
  readonly createdAtWindowSec: number
  readonly bannedPubkeys: Set<string>
}>()("RelayConfig") {}

/** RelayConfig layer - provides host/port from environment */
export const RelayConfigLive = Layer.effect(RelayConfig)(
  Effect.gen(function*() {
    const config = yield* RelayConfigSchema
    return {
      host: config.host,
      port: config.port,
      createdAtWindowSec: config.createdAtWindowSec,
      bannedPubkeys: config.bannedPubkeys
    }
  })
)
