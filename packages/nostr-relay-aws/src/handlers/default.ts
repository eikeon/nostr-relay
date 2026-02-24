import { Logger } from "@aws-lambda-powertools/logger"
import {
  ApiGatewayManagementApiClient,
  GoneException,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi"
import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb"
import { HEX64 } from "@eikeon/nostr-relay/constants"
import { validateFilters } from "@eikeon/nostr-relay/filter"
import { type NostrEvent, NostrEventSchema, type NostrFilter, parseFilter } from "@eikeon/nostr-relay/schema"
import { RelayStore, SubscriptionService } from "@eikeon/nostr-relay/services"
import type { APIGatewayProxyWebsocketEventV2 } from "aws-lambda"
import { Effect, Exit, Layer, Schema } from "effect"
import { verifyEvent } from "nostr-tools/pure"
import { RelayStoreDynamoLive } from "../relay-store-dynamodb.js"
import { SubscriptionServiceDynamoLive } from "../services/index.js"

const logger = new Logger({ serviceName: "nostr-relay" })
const dynamo = new DynamoDBClient({})
const docClient = DynamoDBDocumentClient.from(dynamo)

const dynamoRelayLayer = Layer.mergeAll(RelayStoreDynamoLive, SubscriptionServiceDynamoLive)

const runWithStoreAndSubs = (
  program: Effect.Effect<void, unknown, RelayStore | SubscriptionService>,
) => Effect.runPromise(program.pipe(Effect.provide(dynamoRelayLayer)))

const decodeEvent = Schema.decodeUnknownSync(NostrEventSchema)

function getEventId(raw: unknown): string {
  if (typeof raw === "object" && raw !== null && "id" in raw && typeof (raw as { id: unknown }).id === "string") {
    return (raw as { id: string }).id
  }
  return "unknown"
}

function getBannedPubkeys(): Set<string> {
  const s = process.env.RELAY_BANNED_PUBKEYS ?? ""
  return new Set(
    s
      .split(",")
      .map((p) => p.trim().toLowerCase())
      .filter((p) => HEX64.test(p)),
  )
}

const createdAtWindowSec = Number(process.env.RELAY_CREATED_AT_WINDOW_SEC ?? "900")

function sendToConnection(endpoint: string, connectionId: string, msg: unknown): Effect.Effect<void> {
  return Effect.promise(async () => {
    const client = new ApiGatewayManagementApiClient({ endpoint })
    const data = JSON.stringify(msg)
    try {
      await client.send(
        new PostToConnectionCommand({ ConnectionId: connectionId, Data: data }),
      )
    } catch (err) {
      if (err instanceof GoneException) {
        logger.debug("PostToConnection failed: connection gone", { connectionId, msg })
      } else {
        logger.error("PostToConnection failed", { connectionId, msg, error: err })
      }
    }
  })
}

function getConnectionAuth(
  connectionId: string,
): Effect.Effect<{ authenticatedPubkey?: string; challenge?: string } | null> {
  const subsTable = process.env.SUBS_TABLE!
  return Effect.promise(async () => {
    try {
      const res = await docClient.send(
        new QueryCommand({
          TableName: subsTable,
          KeyConditionExpression: "connectionId = :c",
          ExpressionAttributeValues: { ":c": connectionId },
          Limit: 5,
        }),
      )
      const challengeItem = res.Items?.find((i) => i.subId === "__challenge")
      const authItem = res.Items?.find((i) => i.authenticatedPubkey)
      return {
        challenge: challengeItem?.challenge as string | undefined,
        authenticatedPubkey: (authItem?.authenticatedPubkey ?? challengeItem?.authenticatedPubkey) as
          | string
          | undefined,
      }
    } catch (err) {
      logger.error("getConnectionAuth failed", { connectionId, error: err })
      return null
    }
  })
}

function handleMessage(
  connectionId: string,
  endpoint: string,
  domainName: string,
  type: string,
  args: unknown[],
  authState: { authenticatedPubkey?: string; challenge?: string } | null,
): Effect.Effect<void, unknown, RelayStore | SubscriptionService> {
  const requireAuth = process.env.RELAY_REQUIRE_AUTH === "true"
  const isAuthed = !!authState?.authenticatedPubkey

  return Effect.gen(function*() {
    const store = yield* RelayStore
    const subs = yield* SubscriptionService
    if (requireAuth && !isAuthed && type !== "AUTH") {
      yield* sendToConnection(endpoint, connectionId, [
        "CLOSED",
        args[0] ?? "sub",
        "auth-required: authentication required",
      ])
      return
    }

    switch (type) {
      case "EVENT": {
        const eventId = getEventId(args[0])
        const sendOk = (accepted: boolean, reason: string) =>
          sendToConnection(endpoint, connectionId, ["OK", eventId, accepted, reason])

        const evExit = yield* Effect.sync(() => decodeEvent(args[0]) as NostrEvent).pipe(Effect.exit)
        if (Exit.isFailure(evExit)) {
          yield* sendOk(false, "invalid: malformed event")
          return
        }
        const ev = evExit.value as NostrEvent

        if (!verifyEvent(ev as Parameters<typeof verifyEvent>[0])) {
          yield* sendOk(false, "invalid: bad signature")
          return
        }

        const banned = getBannedPubkeys()
        if (banned.has(ev.pubkey)) {
          yield* sendOk(false, "banned")
          return
        }

        const now = Math.floor(Date.now() / 1000)
        if (Math.abs(ev.created_at - now) > createdAtWindowSec) {
          yield* sendOk(false, "invalid: event creation date is too far off from the current time")
          return
        }

        const { duplicate } = yield* store.storeEvent(ev)
        yield* sendOk(true, duplicate ? "duplicate: already have this event" : "")

        if (!duplicate) {
          const matching = yield* subs.getMatchingSubs(ev)
          for (const m of matching) {
            if (m.send) {
              yield* m.send(["EVENT", m.subId, ev])
            } else {
              yield* sendToConnection(endpoint, m.connKey, ["EVENT", m.subId, ev])
            }
          }
        }
        break
      }

      case "REQ": {
        const subId = typeof args[0] === "string" ? args[0] : undefined
        if (!subId || subId.length === 0) {
          yield* sendToConnection(endpoint, connectionId, ["NOTICE", "invalid: subscription_id required"])
          return
        }
        if (subId.length > 64) {
          yield* sendToConnection(endpoint, connectionId, ["NOTICE", "invalid: subscription_id max 64 chars"])
          return
        }

        const filterInputs = args.slice(1) as unknown[]
        const filters: NostrFilter[] = filterInputs.length > 0
          ? filterInputs.map((f) => parseFilter(f))
          : [{} as NostrFilter]

        const filterError = validateFilters(filters)
        if (filterError) {
          yield* sendToConnection(endpoint, connectionId, ["NOTICE", filterError])
          return
        }

        const historical = yield* subs.getHistoricalEvents(filters)
        for (const ev of historical) {
          yield* sendToConnection(endpoint, connectionId, ["EVENT", subId, ev])
        }
        yield* sendToConnection(endpoint, connectionId, ["EOSE", subId])

        yield* subs.addSub(
          connectionId,
          subId,
          filters,
          undefined,
          isAuthed ? authState?.authenticatedPubkey : undefined,
        )
        break
      }

      case "CLOSE": {
        const subId = typeof args[0] === "string" ? args[0] : undefined
        if (subId) {
          yield* subs.removeSub(connectionId, subId)
        }
        break
      }

      case "AUTH": {
        const authEvent = args[0] as { kind?: number; id?: string; pubkey?: string; tags?: string[][] } | undefined
        if (!authEvent || authEvent.kind !== 22242) break

        const challenge = authState?.challenge
        if (!challenge) break

        const hasChallenge = authEvent.tags?.some((t) => t[0] === "challenge" && t[1] === challenge)
        const hasRelay = authEvent.tags?.some((t) => t[0] === "relay" && t[1]?.includes(domainName))
        if (
          !verifyEvent(authEvent as Parameters<typeof verifyEvent>[0]) ||
          !hasChallenge ||
          !hasRelay
        ) {
          yield* sendToConnection(endpoint, connectionId, [
            "OK",
            authEvent.id ?? "",
            false,
            "invalid: auth verification failed",
          ])
          break
        }

        const subsTable = process.env.SUBS_TABLE!
        yield* Effect.promise(async () => {
          await docClient.send(
            new PutCommand({
              TableName: subsTable,
              Item: {
                connectionId,
                subId: "__challenge",
                challenge,
                authenticatedPubkey: authEvent.pubkey,
                ttl: Math.floor(Date.now() / 1000) + 86400,
              },
            }),
          )
        })
        yield* sendToConnection(endpoint, connectionId, ["OK", authEvent.id ?? "", true, ""])
        break
      }

      default:
        yield* sendToConnection(endpoint, connectionId, ["NOTICE", "Unknown message type"])
    }
  })
}

export const handler = async (event: APIGatewayProxyWebsocketEventV2) => {
  const connectionId = event.requestContext.connectionId!
  const domain = event.requestContext.domainName
  const stage = event.requestContext.stage
  const isExecuteApi = domain.includes("execute-api")
  const endpoint = isExecuteApi
    ? `https://${domain}/${stage}`
    : (process.env.RELAY_WEBSOCKET_EXECUTE_API_ENDPOINT ?? `https://${domain}`)

  let msg: unknown[]
  try {
    msg = JSON.parse(event.body ?? "[]")
  } catch (err) {
    logger.error("Invalid JSON in message", { body: event.body, error: err })
    await Effect.runPromise(sendToConnection(endpoint, connectionId, ["NOTICE", "Invalid JSON"]))
    return { statusCode: 200 }
  }

  if (!Array.isArray(msg) || msg.length === 0) {
    await Effect.runPromise(sendToConnection(endpoint, connectionId, ["NOTICE", "Invalid message"]))
    return { statusCode: 200 }
  }

  const type = String(msg[0])
  const args = msg.slice(1)

  const authState = await Effect.runPromise(getConnectionAuth(connectionId))

  const domainName = event.requestContext.domainName
  const program = handleMessage(connectionId, endpoint, domainName, type, args, authState)
  await runWithStoreAndSubs(program)

  return { statusCode: 200 }
}
