/**
 * NIP-01 NOSTR relay - WebSocket server via Effect v4
 * @eikeon/nostr-relay
 *
 * Run with: npm run dev
 * Connects at: ws://localhost:8181 or ws://purple.local:8181
 */

import { NodeRuntime, NodeSocketServer } from "@effect/platform-node"
import type { ServiceMap } from "effect"
import { Cause, ConfigProvider, Data, Effect, Layer, Logger, Ref, Schema } from "effect"
import { DevTools } from "effect/unstable/devtools"
import { CloseEvent, type Socket } from "effect/unstable/socket/Socket"
import { verifyEvent } from "nostr-tools/pure"
import { matchesFilter, validateFilters } from "./filter.js"
import { RelayStoreLive } from "./relay-store-memory.js"
import { type NostrEvent, NostrEventSchema, type NostrFilter, parseFilter } from "./schema.js"
import { RelayConfig, RelayConfigLive, RelayStore, subKey } from "./services.js"

class InvalidMessageError extends Data.TaggedError("InvalidMessageError")<{
  readonly message: string
}> {}

const toJsonString = (value: unknown): string => Schema.encodeUnknownSync(Schema.UnknownFromJsonString)(value)

/** WebSocket close code 1001 = Going Away (normal tab close). Skip logging. */
function isGoingAwayClose(cause: Cause.Cause<unknown>): boolean {
  if (!Cause.isCause(cause)) return false
  const hasCode1001 = (err: unknown) =>
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: number }).code === 1001
  return cause.reasons.some((r) => {
    if (Cause.isFailReason(r)) return hasCode1001(r.error)
    if (Cause.isDieReason(r)) return hasCode1001(r.defect)
    return false
  })
}

const getEventId = (raw: unknown): string =>
  typeof raw === "object" &&
    raw !== null &&
    "id" in raw &&
    typeof (raw as { id: unknown }).id === "string"
    ? (raw as { id: string }).id
    : ""

const handleNostrConnection = (
  socket: Socket,
  store: ServiceMap.Service.Shape<typeof RelayStore>,
  config: ServiceMap.Service.Shape<typeof RelayConfig>
) =>
  Effect.gen(function*() {
    const connKey = crypto.randomUUID()
    const clientSubsRef = yield* Ref.make<Set<string>>(new Set())
    const writer = yield* socket.writer
    const send = (msg: string) => writer(msg)
    /** Close connection with code (e.g. 4000 = client should not reconnect per NIP-01). */
    const closeWithCode = (code: number, reason?: string) => writer(new CloseEvent(code, reason))

    yield* Effect.logInfo("client connected")

    const removeClientFromSubs = Effect.gen(function*() {
      const clientSubs = yield* Ref.get(clientSubsRef)
      yield* Effect.logInfo("client disconnected", { subs: [...clientSubs] })
      yield* store.updateSubs((m) => {
        const next = new Map(m)
        for (const subId of clientSubs) {
          next.delete(subKey(connKey, subId))
        }
        return next
      })
    })

    const handleMessage = (raw: string | Uint8Array) => {
      const data = typeof raw === "string" ? raw : new TextDecoder().decode(raw)
      return Effect.gen(function*() {
        const parseResult = yield* Schema.decodeUnknownEffect(
          Schema.UnknownFromJsonString
        )(data).pipe(
          Effect.flatMap((msg) =>
            Array.isArray(msg) && msg.length > 0
              ? Effect.succeed(msg)
              : Effect.fail(
                new InvalidMessageError({
                  message: "Expected non-empty array"
                })
              )
          ),
          Effect.catchTag("InvalidMessageError", (err) =>
            Effect.gen(function*() {
              yield* Effect.logInfo("invalid message", err.message)
              yield* send(toJsonString(["NOTICE", "Invalid message"]))
              return null
            })),
          Effect.catch((err: unknown) =>
            Effect.gen(function*() {
              yield* Effect.logInfo("parse error", err)
              yield* send(toJsonString(["NOTICE", "Invalid message"]))
              return null
            })
          )
        )
        if (parseResult === null) return

        const [type, ...args] = parseResult
        yield* Effect.logInfo(
          "incoming",
          type,
          args.length > 0 ? toJsonString(args).slice(0, 1000) + "..." : ""
        )

        switch (type) {
          case "EVENT": {
            const eventId = getEventId(args[0])
            const sendOk = (accepted: boolean, msg: string) =>
              send(toJsonString(["OK", eventId || "unknown", accepted, msg]))

            const decodeEvent = Schema.decodeUnknownEffect(NostrEventSchema)(
              args[0]
            )
            const eventResult = yield* decodeEvent.pipe(
              Effect.catch(() => Effect.succeed(null))
            )
            if (!eventResult) {
              yield* Effect.logInfo("invalid event structure")
              yield* sendOk(false, "invalid: malformed event")
              return
            }

            if (
              !verifyEvent(eventResult as Parameters<typeof verifyEvent>[0])
            ) {
              yield* Effect.logInfo("invalid event signature", {
                id: eventResult.id
              })
              yield* sendOk(false, "invalid: bad signature")
              return
            }

            if (config.bannedPubkeys.has(eventResult.pubkey)) {
              yield* Effect.logInfo("banned pubkey attempted to publish", {
                pubkey: eventResult.pubkey,
                id: eventResult.id
              })
              yield* closeWithCode(4000, "banned")
              return
            }

            const now = Math.floor(Date.now() / 1000)
            const window = config.createdAtWindowSec
            if (Math.abs(eventResult.created_at - now) > window) {
              yield* Effect.logInfo("invalid event created_at", {
                id: eventResult.id,
                created_at: eventResult.created_at,
                now
              })
              yield* sendOk(
                false,
                "invalid: event creation date is too far off from the current time"
              )
              return
            }

            const { duplicate } = yield* store.storeEvent(eventResult)

            yield* sendOk(
              true,
              duplicate ? "duplicate: already have this event" : ""
            )

            const subs = yield* store.getSubs()
            for (const [, { send: subSend, filters, subId }] of subs) {
              if (!matchesFilter(eventResult, filters)) continue
              yield* subSend(toJsonString(["EVENT", subId, eventResult])).pipe(
                Effect.catch(() => Effect.void)
              )
            }
            break
          }
          case "REQ": {
            const subId = typeof args[0] === "string" ? args[0] : undefined
            if (!subId || subId.length === 0) {
              yield* send(
                toJsonString(["NOTICE", "invalid: subscription_id required"])
              )
              return
            }
            if (subId.length > 64) {
              yield* send(
                toJsonString([
                  "NOTICE",
                  "invalid: subscription_id max 64 chars"
                ])
              )
              return
            }

            const filterInputs = args.slice(1) as unknown[]
            const filters_: NostrFilter[] = filterInputs.length > 0
              ? filterInputs.map((f: unknown) => parseFilter(f))
              : [{} as NostrFilter]

            const filterError = validateFilters(filters_)
            if (filterError) {
              yield* send(toJsonString(["NOTICE", filterError]))
              return
            }

            yield* Ref.update(clientSubsRef, (s) => {
              const next = new Set(s)
              next.add(subId)
              return next
            })

            yield* store.updateSubs((m) => {
              const next = new Map(m)
              next.set(subKey(connKey, subId), {
                connKey,
                subId,
                send,
                filters: filters_
              })
              return next
            })

            const events = yield* store.getEvents()
            const eventList = [...events.values()].filter((ev) => matchesFilter(ev as NostrEvent, filters_))
            eventList.sort((a, b) => {
              const ca = (a as NostrEvent).created_at
              const cb = (b as NostrEvent).created_at
              if (cb !== ca) return cb - ca
              return (a as NostrEvent).id.localeCompare((b as NostrEvent).id)
            })
            const limits = filters_
              .map((f) => f.limit)
              .filter((n): n is number => n !== undefined)
            const limit = limits.length > 0 ? Math.min(...limits) : undefined
            const toSend = limit !== undefined ? eventList.slice(0, limit) : eventList
            for (const ev of toSend) {
              yield* send(toJsonString(["EVENT", subId, ev]))
            }
            yield* send(toJsonString(["EOSE", subId]))
            break
          }
          case "CLOSE": {
            const subId = typeof args[0] === "string" ? args[0] : undefined
            if (subId) {
              yield* Ref.update(clientSubsRef, (s) => {
                const next = new Set(s)
                next.delete(subId)
                return next
              })
              yield* store.updateSubs((m) => {
                const next = new Map(m)
                next.delete(subKey(connKey, subId))
                return next
              })
            }
            break
          }
        }
      })
    }

    yield* socket.runRaw(handleMessage).pipe(
      Effect.ensuring(removeClientFromSubs),
      Effect.catchCause((cause) =>
        Effect.gen(function*() {
          if (isGoingAwayClose(cause)) return
          yield* Effect.logInfo("connection error", cause)
        })
      )
    )
  })

const RelayServerLive = Layer.merge(RelayStoreLive, RelayConfigLive)

const program = Effect.gen(function*() {
  const store = yield* RelayStore
  const config = yield* RelayConfig
  const { host, port } = config

  const server = yield* NodeSocketServer.makeWebSocket({
    host,
    port
  })
  yield* Effect.logInfo(`listening on ws://${host}:${port}`)
  yield* Effect.logInfo(
    `connect via: ws://localhost:${port} or ws://purple.local:${port}`
  )
  return yield* server.run((socket) => handleNostrConnection(socket, store, config).pipe(Effect.asVoid))
}).pipe(Effect.annotateLogs("component", "relay"), Effect.scoped)

const AppLayer = Layer.mergeAll(
  RelayServerLive,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
  DevTools.layer(),
  Logger.layer([Logger.consolePretty()])
)

NodeRuntime.runMain(program.pipe(Effect.provide(AppLayer)))
