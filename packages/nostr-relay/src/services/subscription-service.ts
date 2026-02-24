/**
 * SubscriptionService - interface and tag only (no implementation)
 * Implementations: subscription-service-memory.ts, subscription-service-dynamodb.ts
 */

import type { Effect } from "effect"
import { ServiceMap } from "effect"
import type { NostrEvent, NostrFilter } from "../schema.js"

export type SubscriptionMatch =
  | { connKey: string; subId: string; send: (msg: unknown) => Effect.Effect<void> }
  | { connKey: string; subId: string; send?: undefined }

export interface SubscriptionServiceShape {
  readonly addSub: (
    connKey: string,
    subId: string,
    filters: NostrFilter[],
    send?: (msg: unknown) => Effect.Effect<void>,
    authenticatedPubkey?: string,
  ) => Effect.Effect<void>
  readonly removeSub: (connKey: string, subId: string) => Effect.Effect<void>
  readonly getMatchingSubs: (event: NostrEvent) => Effect.Effect<SubscriptionMatch[]>
  readonly getHistoricalEvents: (
    filters: NostrFilter[],
    limit?: number,
  ) => Effect.Effect<NostrEvent[]>
}

export class SubscriptionService extends ServiceMap.Service<
  SubscriptionService,
  SubscriptionServiceShape
>()("SubscriptionService") {}
