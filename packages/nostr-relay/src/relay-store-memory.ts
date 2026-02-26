/**
 * In-memory implementation of RelayStore with NIP-01 replaceable/ephemeral/addressable semantics
 */

import { Effect, Layer, Ref } from "effect"
import { addressableKey, isAddressable, isEphemeral, isReplaceable, replaceableKey, shouldReplace } from "./nip01.js"
import type { NostrEvent } from "./schema.js"
import { RelayStore } from "./services.js"

function allEventIds(
  regular: Map<string, NostrEvent>,
  replaceable: Map<string, NostrEvent>,
  addressable: Map<string, NostrEvent>,
): Set<string> {
  const ids = new Set<string>()
  for (const e of regular.values()) ids.add(e.id)
  for (const e of replaceable.values()) ids.add(e.id)
  for (const e of addressable.values()) ids.add(e.id)
  return ids
}

function mergeEvents(
  regular: Map<string, NostrEvent>,
  replaceable: Map<string, NostrEvent>,
  addressable: Map<string, NostrEvent>,
): Map<string, NostrEvent> {
  const result = new Map<string, NostrEvent>()
  for (const e of regular.values()) result.set(e.id, e)
  for (const e of replaceable.values()) result.set(e.id, e)
  for (const e of addressable.values()) result.set(e.id, e)
  return result
}

/** RelayStore layer - creates the in-memory store */
export const RelayStoreLive = Layer.effect(RelayStore)(
  Effect.gen(function*() {
    const regularRef = yield* Ref.make<Map<string, NostrEvent>>(new Map())
    const replaceableRef = yield* Ref.make<Map<string, NostrEvent>>(new Map())
    const addressableRef = yield* Ref.make<Map<string, NostrEvent>>(new Map())

    return {
      hasEvent: (id: string) =>
        Effect.gen(function*() {
          const [regular, replaceable, addressable] = yield* Effect.all([
            Ref.get(regularRef),
            Ref.get(replaceableRef),
            Ref.get(addressableRef),
          ])
          return allEventIds(regular, replaceable, addressable).has(id)
        }),

      storeEvent: (event: NostrEvent) =>
        Effect.gen(function*() {
          const [regular, replaceable, addressable] = yield* Effect.all([
            Ref.get(regularRef),
            Ref.get(replaceableRef),
            Ref.get(addressableRef),
          ])
          const has = allEventIds(regular, replaceable, addressable).has(event.id)
          if (has) return { duplicate: true }

          if (isEphemeral(event.kind)) return { duplicate: false }

          if (isReplaceable(event.kind)) {
            const key = replaceableKey(event)
            yield* Ref.update(replaceableRef, (m) => {
              const next = new Map(m)
              const existing = next.get(key)
              if (!existing || shouldReplace(existing, event)) {
                next.set(key, event)
              }
              return next
            })
            return { duplicate: false }
          }

          if (isAddressable(event.kind)) {
            const key = addressableKey(event)
            yield* Ref.update(addressableRef, (m) => {
              const next = new Map(m)
              const existing = next.get(key)
              if (!existing || shouldReplace(existing, event)) {
                next.set(key, event)
              }
              return next
            })
            return { duplicate: false }
          }

          yield* Ref.update(regularRef, (m) => {
            const next = new Map(m)
            next.set(event.id, event)
            return next
          })
          return { duplicate: false }
        }),

      getEvents: () =>
        Effect.gen(function*() {
          const [regular, replaceable, addressable] = yield* Effect.all([
            Ref.get(regularRef),
            Ref.get(replaceableRef),
            Ref.get(addressableRef),
          ])
          return mergeEvents(regular, replaceable, addressable)
        }),
    }
  }),
)
