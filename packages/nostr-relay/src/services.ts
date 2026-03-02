/**
 * Effect services and layers for the NOSTR relay
 */

import { Config, Effect, Layer, ServiceMap } from "effect"
import { HEX64 } from "./constants.js"
import type { NostrEvent, NostrFilter } from "./schema.js"

const RelayConfigSchema = Config.all({
  port: Config.number("RELAY_PORT").pipe(Config.withDefault(() => 8181)),
  host: Config.string("RELAY_HOST").pipe(Config.withDefault(() => "0.0.0.0")),
  createdAtWindowSec: Config.number("RELAY_CREATED_AT_WINDOW_SEC").pipe(Config.withDefault(() => 900)),
  requireAuth: Config.boolean("RELAY_REQUIRE_AUTH").pipe(Config.withDefault(() => false)),
  bannedPubkeys: Config.string("RELAY_BANNED_PUBKEYS").pipe(
    Config.withDefault(() => ""),
    Config.map((s) =>
      new Set(
        s
          .split(",")
          .map((p) => p.trim().toLowerCase())
          .filter((p) => HEX64.test(p)),
      )
    ),
  ),
})

/** RelayStore - in-memory event store (subscriptions handled by SubscriptionService) */
export class RelayStore extends ServiceMap.Service<RelayStore, {
  readonly hasEvent: (id: string) => Effect.Effect<boolean>
  readonly storeEvent: (event: NostrEvent) => Effect.Effect<{ duplicate: boolean }>
  readonly getEvents: () => Effect.Effect<Map<string, NostrEvent>>
  readonly getEventsByFilter: (filters: NostrFilter[], limit: number) => Effect.Effect<NostrEvent[]>
}>()("RelayStore") {}

/** RelayConfig - host, port, validation settings, banned pubkeys, and NIP-42 requireAuth */
export class RelayConfig extends ServiceMap.Service<RelayConfig, {
  readonly host: string
  readonly port: number
  readonly createdAtWindowSec: number
  readonly requireAuth: boolean
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
      requireAuth: config.requireAuth,
      bannedPubkeys: config.bannedPubkeys,
    }
  }),
)
