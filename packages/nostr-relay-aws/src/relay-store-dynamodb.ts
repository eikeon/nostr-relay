import { Logger } from "@aws-lambda-powertools/logger"
import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb"
import { matchesFilter } from "@eikeon/nostr-relay/filter"
import { isAddressable, isEphemeral, isReplaceable } from "@eikeon/nostr-relay/nip01"
import type { NostrEvent, NostrFilter } from "@eikeon/nostr-relay/schema"
import { RelayStore } from "@eikeon/nostr-relay/services"
import { Effect, Layer, ServiceMap } from "effect"

const logger = new Logger({ serviceName: "nostr-relay" })
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}))

export interface DynamoConfig {
  readonly eventsTable: string
  readonly subsTable: string
  readonly subsKindIndexTable: string
}

export class DynamoConfigService extends ServiceMap.Service<DynamoConfigService, DynamoConfig>()("DynamoConfig") {}

export const DynamoConfigLive = Layer.succeed(DynamoConfigService, {
  eventsTable: process.env.EVENTS_TABLE ?? "EventsTable",
  subsTable: process.env.SUBS_TABLE ?? "SubscriptionsTable",
  subsKindIndexTable: process.env.SUBS_KIND_INDEX_TABLE ?? "SubscriptionKindIndexTable",
})

/** RelayStore DynamoDB implementation - for Lambda/serverless. Subs managed via connect/disconnect handlers. */
export const RelayStoreDynamoLive = Layer.effect(RelayStore)(
  Effect.gen(function*() {
    yield* Effect.void
    const eventsTable = process.env.EVENTS_TABLE ?? "EventsTable"
    return {
      hasEvent: (id: string) =>
        Effect.promise(async () => {
          try {
            const res = await docClient.send(
              new GetCommand({ TableName: eventsTable, Key: { id } }),
            )
            return !!res.Item
          } catch (err) {
            logger.error("hasEvent failed", { id, error: err })
            return false
          }
        }),
      storeEvent: (event: NostrEvent) =>
        Effect.promise(async () => {
          try {
            const existing = await docClient.send(
              new GetCommand({ TableName: eventsTable, Key: { id: event.id } }),
            )
            if (existing.Item) return { duplicate: true }
            if (isEphemeral(event.kind)) return { duplicate: false }

            const putParams = {
              TableName: eventsTable,
              Item: { ...event },
              ...(isReplaceable(event.kind) || isAddressable(event.kind)
                ? {
                  ConditionExpression: "attribute_not_exists(id) OR created_at < :newTime",
                  ExpressionAttributeValues: { ":newTime": event.created_at },
                }
                : {}),
            }
            await docClient.send(new PutCommand(putParams))
            return { duplicate: false }
          } catch (err) {
            const name = (err as { name?: string })?.name
            if (name === "ConditionalCheckFailedException") {
              return { duplicate: true }
            }
            logger.error("storeEvent failed", { eventId: event.id, error: err })
            throw err
          }
        }),
      getEvents: () =>
        Effect.promise(async () => {
          try {
            const allItems: NostrEvent[] = []
            let lastKey: Record<string, unknown> | undefined
            do {
              const res = await docClient.send(
                new ScanCommand({
                  TableName: eventsTable,
                  ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
                }),
              )
              const items = (res.Items ?? []) as NostrEvent[]
              allItems.push(...items)
              lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined
            } while (lastKey)

            const map = new Map<string, NostrEvent>(allItems.map((e) => [e.id, e]))
            logger.info("getEvents", { total: map.size, kinds: [...new Set(allItems.map((e) => e.kind))] })
            return map
          } catch (err) {
            logger.error("getEvents failed", { error: err })
            return new Map<string, NostrEvent>()
          }
        }),

      getEventsByFilter: (filters: NostrFilter[], limit: number) =>
        Effect.promise(async () => {
          const filtersArr = Array.isArray(filters) ? filters : [filters]
          const canUseKindIndex = filtersArr.every(
            (f) =>
              f.kinds &&
              f.kinds.length > 0 &&
              (!f.authors || f.authors.length === 0) &&
              (!f.ids || f.ids.length === 0),
          )
          const canUseAuthorIndex = filtersArr.every(
            (f) =>
              f.authors &&
              f.authors.length > 0 &&
              (!f.ids || f.ids.length === 0),
          )

          if (canUseAuthorIndex) {
            const authors = [...new Set(filtersArr.flatMap((f) => f.authors ?? []))]
            const since = filtersArr.map((f) => f.since).filter((s): s is number => s !== undefined)
            const until = filtersArr.map((f) => f.until).filter((u): u is number => u !== undefined)
            const minSince = since.length > 0 ? Math.max(...since) : undefined
            const maxUntil = until.length > 0 ? Math.min(...until) : undefined
            try {
              const allItems: NostrEvent[] = []
              for (const pubkey of authors) {
                const keyCond = minSince !== undefined || maxUntil !== undefined
                  ? "pubkey = :p AND created_at BETWEEN :lo AND :hi"
                  : "pubkey = :p"
                const exprValues: Record<string, string | number> = { ":p": pubkey }
                if (minSince !== undefined) exprValues[":lo"] = minSince
                if (maxUntil !== undefined) exprValues[":hi"] = maxUntil
                if (minSince === undefined && maxUntil !== undefined) exprValues[":lo"] = 0
                if (maxUntil === undefined && minSince !== undefined) exprValues[":hi"] = Math.floor(Date.now() / 1000)

                const res = await docClient.send(
                  new QueryCommand({
                    TableName: eventsTable,
                    IndexName: "pubkey-created_at-index",
                    KeyConditionExpression: keyCond,
                    ExpressionAttributeValues: exprValues,
                    ScanIndexForward: false,
                    Limit: limit,
                  }),
                )
                allItems.push(...((res.Items ?? []) as NostrEvent[]))
              }
              const evs = allItems.filter((e) => matchesFilter(e, filtersArr))
              evs.sort((a, b) => b.created_at - a.created_at)
              const result = evs.slice(0, limit)
              logger.info("getEventsByFilter", {
                index: "pubkey-created_at",
                authors: authors.length,
                totalQueried: allItems.length,
                returning: result.length,
              })
              return result
            } catch (err) {
              logger.error("getEventsByFilter Query (pubkey) failed", { error: err })
              return []
            }
          }

          if (!canUseKindIndex) {
            try {
              const allItems: NostrEvent[] = []
              let lastKey: Record<string, unknown> | undefined
              do {
                const res = await docClient.send(
                  new ScanCommand({
                    TableName: eventsTable,
                    ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
                  }),
                )
                allItems.push(...((res.Items ?? []) as NostrEvent[]))
                lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined
              } while (lastKey)
              const evs = allItems.filter((e) => matchesFilter(e, filtersArr))
              evs.sort((a, b) => b.created_at - a.created_at)
              const result = evs.slice(0, limit)
              logger.warn("getEventsByFilter using Scan fallback (no index match)", {
                filters: filtersArr,
                limit,
                totalScanned: allItems.length,
                returning: result.length,
              })
              return result
            } catch (err) {
              logger.error("getEventsByFilter Scan fallback failed", { filters: filtersArr, error: err })
              return []
            }
          }

          const kinds = [...new Set(filtersArr.flatMap((f) => f.kinds ?? []))]
          const since = filtersArr.map((f) => f.since).filter((s): s is number => s !== undefined)
          const until = filtersArr.map((f) => f.until).filter((u): u is number => u !== undefined)
          const minSince = since.length > 0 ? Math.max(...since) : undefined
          const maxUntil = until.length > 0 ? Math.min(...until) : undefined
          try {
            const allItems: NostrEvent[] = []
            for (const kind of kinds) {
              const keyCond = minSince !== undefined || maxUntil !== undefined
                ? "kind = :k AND created_at BETWEEN :lo AND :hi"
                : "kind = :k"
              const exprValues: Record<string, number> = { ":k": kind }
              if (minSince !== undefined) exprValues[":lo"] = minSince
              if (maxUntil !== undefined) exprValues[":hi"] = maxUntil
              if (minSince === undefined && maxUntil !== undefined) exprValues[":lo"] = 0
              if (maxUntil === undefined && minSince !== undefined) exprValues[":hi"] = Math.floor(Date.now() / 1000)

              const res = await docClient.send(
                new QueryCommand({
                  TableName: eventsTable,
                  IndexName: "kind-created_at-index",
                  KeyConditionExpression: keyCond,
                  ExpressionAttributeValues: exprValues,
                  ScanIndexForward: false,
                  Limit: limit,
                }),
              )
              const items = (res.Items ?? []) as NostrEvent[]
              allItems.push(...items)
            }
            const seen = new Set<string>()
            const deduped = allItems.filter((e) => {
              if (seen.has(e.id)) return false
              seen.add(e.id)
              return true
            })
            deduped.sort((a, b) => b.created_at - a.created_at)
            const result = deduped.slice(0, limit)
            logger.info("getEventsByFilter", {
              kinds,
              totalQueried: allItems.length,
              returning: result.length,
            })
            return result
          } catch (err) {
            logger.error("getEventsByFilter Query failed", { kinds, error: err })
            return []
          }
        }),
    }
  }),
)
