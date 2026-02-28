import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb"
import { isAddressable, isEphemeral, isReplaceable } from "@eikeon/nostr-relay/nip01"
import type { NostrEvent } from "@eikeon/nostr-relay/schema"
import { RelayStore } from "@eikeon/nostr-relay/services"
import { Effect, Layer, ServiceMap } from "effect"

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}))

export interface DynamoConfig {
  readonly eventsTable: string
  readonly subsTable: string
}

export class DynamoConfigService extends ServiceMap.Service<DynamoConfigService, DynamoConfig>()("DynamoConfig") {}

export const DynamoConfigLive = Layer.succeed(DynamoConfigService, {
  eventsTable: process.env.EVENTS_TABLE ?? "EventsTable",
  subsTable: process.env.SUBS_TABLE ?? "SubscriptionsTable",
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
            console.error("hasEvent failed", { id, error: err })
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
            console.error("storeEvent failed", { eventId: event.id, error: err })
            return { duplicate: false }
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
            console.log("[relay] getEvents", { total: map.size, kinds: [...new Set(allItems.map((e) => e.kind))] })
            return map
          } catch (err) {
            console.error("getEvents failed", { error: err })
            return new Map<string, NostrEvent>()
          }
        }),
    }
  }),
)
