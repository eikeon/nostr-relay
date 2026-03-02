/**
 * DynamoDB implementation of SubscriptionService - for Lambda/serverless
 * Uses SubscriptionKindIndex table to Query by event kind instead of full Scan
 */

import { Logger } from "@aws-lambda-powertools/logger"
import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb"
import { matchesFilter } from "@eikeon/nostr-relay/filter"
import type { NostrFilter } from "@eikeon/nostr-relay/schema"
import { RelayStore } from "@eikeon/nostr-relay/services"
import type { SubscriptionMatch, SubscriptionServiceShape } from "@eikeon/nostr-relay/services"
import { SubscriptionService } from "@eikeon/nostr-relay/services"
import { Effect, Layer, Option, Schedule, Schema } from "effect"
import { DynamoConfigLive, DynamoConfigService, RelayStoreDynamoLive } from "../relay-store-dynamodb.js"

/** kind = -1 means "match all kinds" (filter has no kinds or empty kinds) */
const MATCH_ALL_KINDS = -1

function getKindsFromFilters(filters: NostrFilter[]): number[] {
  const kinds = new Set<number>()
  for (const f of filters) {
    if (f.kinds && f.kinds.length > 0) {
      for (const k of f.kinds) kinds.add(k)
    } else {
      kinds.add(MATCH_ALL_KINDS)
    }
  }
  return [...kinds]
}

function isThrottlingException(err: unknown): boolean {
  const e = err as { name?: string; __type?: string; cause?: unknown }
  if (e?.name === "ThrottlingException" || e?.__type?.includes("ThrottlingException")) return true
  if (e?.cause) return isThrottlingException(e.cause)
  return false
}

const retryPolicy = {
  times: 5,
  schedule: Schedule.exponential("200 millis"),
  while: isThrottlingException,
} as const

const logger = new Logger({ serviceName: "nostr-relay" })
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const SubscriptionServiceDynamoLiveBase = Layer.effect(SubscriptionService)(
  Effect.gen(function*() {
    const { subsTable, subsKindIndexTable } = yield* DynamoConfigService
    const store = yield* RelayStore

    const impl: SubscriptionServiceShape = {
      addSub: (connKey, subId, filters, _send, authenticatedPubkey) =>
        Effect.gen(function*() {
          const ttl = Math.floor(Date.now() / 1000) + 86400
          const filterJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString)(filters)
          const kinds = getKindsFromFilters(filters)
          const connectionIdSubId = `${connKey}#${subId}`
          for (const kind of kinds) {
            yield* Effect.tryPromise(() =>
              docClient.send(
                new PutCommand({
                  TableName: subsKindIndexTable,
                  Item: {
                    kind,
                    connectionIdSubId,
                    connectionId: connKey,
                    subId,
                    filter: filterJson,
                    authenticatedPubkey: authenticatedPubkey ?? null,
                    ttl,
                  },
                }),
              )
            ).pipe(
              Effect.asVoid,
              Effect.tapError((err) =>
                Effect.sync(() => logger.error("addSub index failed", { connKey, subId, kind, error: err }))
              ),
              Effect.orDie,
            )
          }
          yield* Effect.tryPromise(() =>
            docClient.send(
              new PutCommand({
                TableName: subsTable,
                Item: {
                  connectionId: connKey,
                  subId,
                  filter: filterJson,
                  authenticatedPubkey: authenticatedPubkey ?? null,
                  ttl,
                },
              }),
            )
          ).pipe(
            Effect.asVoid,
            Effect.tapError((err) => Effect.sync(() => logger.error("addSub failed", { connKey, subId, error: err }))),
            Effect.orDie,
          )
        }),

      removeSub: (connKey, subId) =>
        Effect.gen(function*() {
          const itemRes = yield* Effect.tryPromise(() =>
            docClient.send(
              new GetCommand({ TableName: subsTable, Key: { connectionId: connKey, subId } }),
            )
          ).pipe(Effect.catch(() => Effect.succeed({ Item: undefined })))
          const item = itemRes.Item
          if (item?.filter) {
            const filters = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(
              item.filter as string,
            ) as NostrFilter[]
            const kinds = getKindsFromFilters(Array.isArray(filters) ? filters : [filters])
            const connectionIdSubId = `${connKey}#${subId}`
            for (const kind of kinds) {
              yield* Effect.tryPromise(() =>
                docClient.send(
                  new DeleteCommand({
                    TableName: subsKindIndexTable,
                    Key: { kind, connectionIdSubId },
                  }),
                )
              ).pipe(
                Effect.asVoid,
                Effect.catch((err) =>
                  Effect.sync(() => logger.error("removeSub index failed", { connKey, subId, kind, error: err }))
                ),
              )
            }
          }
          yield* Effect.tryPromise(() =>
            docClient.send(new DeleteCommand({ TableName: subsTable, Key: { connectionId: connKey, subId } }))
          ).pipe(
            Effect.asVoid,
            Effect.catch((err) => Effect.sync(() => logger.error("removeSub failed", { connKey, subId, error: err }))),
          )
        }),

      getMatchingSubs: (event) =>
        Effect.gen(function*() {
          const kindsToQuery = [event.kind, MATCH_ALL_KINDS]
          const seen = new Set<string>()
          const allItems: Record<string, unknown>[] = []

          for (const kind of kindsToQuery) {
            let lastKey: Record<string, unknown> | undefined
            do {
              const res = yield* Effect.tryPromise(() =>
                docClient.send(
                  new QueryCommand({
                    TableName: subsKindIndexTable,
                    KeyConditionExpression: "kind = :k",
                    ExpressionAttributeValues: { ":k": kind },
                    ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
                  }),
                )
              ).pipe(
                Effect.retry(retryPolicy),
                Effect.tapError((err) =>
                  Effect.sync(() => logger.error("getMatchingSubs Query failed", { kind, error: err }))
                ),
                Effect.catch(() =>
                  Effect.succeed({ Items: [] as Record<string, unknown>[], LastEvaluatedKey: undefined })
                ),
              )
              for (const item of res.Items ?? []) {
                const key = `${item.connectionId}#${item.subId}`
                if (!seen.has(key) && item.subId !== "__challenge") {
                  seen.add(key)
                  allItems.push(item)
                }
              }
              lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined
            } while (lastKey)
          }

          const matches: SubscriptionMatch[] = []
          for (const item of allItems) {
            if (!item.filter) continue
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
          logger.info("getHistoricalEvents", {
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
