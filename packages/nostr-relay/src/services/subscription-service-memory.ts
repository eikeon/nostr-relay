/**
 * In-memory implementation of SubscriptionService - for local/dev WebSocket server
 */

import { Effect, Layer, Ref } from "effect"
import { matchesFilter } from "../filter.js"
import type { NostrFilter } from "../schema.js"
import { RelayStore } from "../services.js"
import { SubscriptionService, type SubscriptionServiceShape } from "./subscription-service.js"

export const SubscriptionServiceMemoryLive = Layer.effect(SubscriptionService)(
  Effect.gen(function*() {
    const store = yield* RelayStore
    const subs = yield* Ref.make(
      new Map<
        string,
        {
          connKey: string
          subId: string
          filters: NostrFilter[]
          send: (msg: unknown) => Effect.Effect<void>
        }
      >(),
    )

    const impl: SubscriptionServiceShape = {
      addSub: (connKey, subId, filters, send, _authenticatedPubkey) =>
        Ref.update(subs, (m) => {
          const next = new Map(m)
          next.set(`${connKey}:${subId}`, { connKey, subId, filters, send: send! })
          return next
        }),
      removeSub: (connKey, subId) =>
        Ref.update(subs, (m) => {
          const next = new Map(m)
          next.delete(`${connKey}:${subId}`)
          return next
        }),
      getMatchingSubs: (event) =>
        Effect.gen(function*() {
          const all = yield* Ref.get(subs)
          return Array.from(all.values())
            .filter((sub) => matchesFilter(event, sub.filters))
            .map((sub) => ({ connKey: sub.connKey, subId: sub.subId, send: sub.send }))
        }),
      getHistoricalEvents: (filters, limit = 100) =>
        Effect.gen(function*() {
          const allEvents = yield* store.getEvents()
          const evs = Array.from(allEvents.values()).filter((e) => matchesFilter(e, filters))
          evs.sort((a, b) => b.created_at - a.created_at)
          return evs.slice(0, limit)
        }),
    }
    return impl
  }),
)
