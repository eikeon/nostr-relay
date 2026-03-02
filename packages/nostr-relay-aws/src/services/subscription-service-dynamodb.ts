/**
 * DynamoDB implementation of SubscriptionService - for Lambda/serverless
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb"
import { matchesFilter } from "@eikeon/nostr-relay/filter"
import { RelayStore } from "@eikeon/nostr-relay/services"
import type { SubscriptionMatch, SubscriptionServiceShape } from "@eikeon/nostr-relay/services"
import { SubscriptionService } from "@eikeon/nostr-relay/services"
import { Effect, Layer, Option, Schema } from "effect"
import { DynamoConfigLive, DynamoConfigService, RelayStoreDynamoLive } from "../relay-store-dynamodb.js"

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const SubscriptionServiceDynamoLiveBase = Layer.effect(SubscriptionService)(
  Effect.gen(function*() {
    const { subsTable } = yield* DynamoConfigService
    const store = yield* RelayStore

    const impl: SubscriptionServiceShape = {
      addSub: (connKey, subId, filters, _send, authenticatedPubkey) =>
        Effect.tryPromise(() =>
          docClient.send(
            new PutCommand({
              TableName: subsTable,
              Item: {
                connectionId: connKey,
                subId,
                filter: JSON.stringify(filters),
                authenticatedPubkey: authenticatedPubkey ?? null,
                ttl: Math.floor(Date.now() / 1000) + 86400,
              },
            }),
          )
        ).pipe(Effect.asVoid, Effect.catch((err) => Effect.sync(() => console.error("addSub failed", err)))),

      removeSub: (connKey, subId) =>
        Effect.tryPromise(() =>
          docClient.send(
            new DeleteCommand({
              TableName: subsTable,
              Key: { connectionId: connKey, subId },
            }),
          )
        ).pipe(Effect.asVoid, Effect.catch((err) => Effect.sync(() => console.error("removeSub failed", err)))),

      getMatchingSubs: (event) =>
        Effect.gen(function*() {
          const allItems: Record<string, unknown>[] = []
          let lastKey: Record<string, unknown> | undefined
          do {
            const res = yield* Effect.tryPromise(() =>
              docClient.send(
                new ScanCommand({
                  TableName: subsTable,
                  ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
                }),
              ),
            ).pipe(
              Effect.catch((err) =>
                Effect.gen(function*() {
                  yield* Effect.sync(() => console.error("getMatchingSubs Scan failed", err))
                  return { Items: [] as Record<string, unknown>[], LastEvaluatedKey: undefined }
                }),
              ),
            )
            allItems.push(...(res.Items ?? []))
            lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined
          } while (lastKey)

          const matches: SubscriptionMatch[] = []
          for (const item of allItems) {
            if (!item.filter || item.subId === "__challenge") continue
            const filterOpt = yield* Effect.option(
              Effect.sync(() => Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(item.filter as string)),
            )
            if (
              Option.isSome(filterOpt) &&
              matchesFilter(event, Array.isArray(filterOpt.value) ? filterOpt.value : [filterOpt.value])
            ) {
              matches.push({ connKey: item.connectionId as string, subId: item.subId as string })
            }
          }
          return matches
        }),

      getHistoricalEvents: (filters, limit = 100) =>
        Effect.gen(function*() {
          const filtersArr = Array.isArray(filters) ? filters : [filters]
          const result = yield* store.getEventsByFilter(filtersArr, limit)
          console.log("[relay] getHistoricalEvents", {
            filters: Schema.encodeUnknownSync(Schema.UnknownFromJsonString)(filtersArr),
            returning: result.length,
          })
          return result
        }),
    }
    return impl
  }),
)

export const SubscriptionServiceDynamoLive = Layer.provide(
  SubscriptionServiceDynamoLiveBase,
  Layer.mergeAll(DynamoConfigLive, RelayStoreDynamoLive),
)
