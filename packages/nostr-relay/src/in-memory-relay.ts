/**
 * In-memory NOSTR relay - WebSocket server with RelayStore + SubscriptionServiceMemory
 */

import { NodeSocketServer } from "@effect/platform-node"
import type { ServiceMap } from "effect"
import { Cause, ConfigProvider, Data, Effect, Layer, Logger, Ref, Schema } from "effect"
import { DevTools } from "effect/unstable/devtools"
import { CloseEvent, type Socket } from "effect/unstable/socket/Socket"
import { verifyEvent } from "nostr-tools/pure"
import { getEffectiveLimit, validateFilters } from "./filter.js"
import { RelayStoreLive } from "./relay-store-memory.js"
import { NostrEventSchema, type NostrFilter, parseFilter } from "./schema.js"
import {
  RelayConfig,
  RelayConfigLive,
  RelayStore,
  SubscriptionService,
  SubscriptionServiceMemoryLive,
} from "./services/index.js"

class InvalidMessageError extends Data.TaggedError("InvalidMessageError")<{
  readonly message: string
}> {}

const toJsonString = (value: unknown): string => Schema.encodeUnknownSync(Schema.UnknownFromJsonString)(value)

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

function handleNostrConnection(
  socket: Socket,
  store: ServiceMap.Service.Shape<typeof RelayStore>,
  config: ServiceMap.Service.Shape<typeof RelayConfig>,
  subs: ServiceMap.Service.Shape<typeof SubscriptionService>,
  relayUrl: string,
) {
  return Effect.gen(function*() {
    const connKey = crypto.randomUUID()
    const clientSubsRef = yield* Ref.make<Set<string>>(new Set())
    const authStateRef = yield* Ref.make<{ challenge: string; authenticatedPubkey?: string }>({
      challenge: crypto.randomUUID(),
    })
    const writer = yield* socket.writer
    const send = (msg: unknown) =>
      writer(toJsonString(msg)).pipe(Effect.catch((err) => Effect.logError("send failed", err)))
    const closeWithCode = (code: number, reason?: string) => writer(new CloseEvent(code, reason))

    yield* Effect.logInfo("client connected")

    const authState = yield* Ref.get(authStateRef)
    const sendAuthOnOpen = send(["AUTH", authState.challenge])

    const removeClientFromSubs = Effect.gen(function*() {
      const clientSubs = yield* Ref.get(clientSubsRef)
      yield* Effect.logInfo("client disconnected", { subs: [...clientSubs] })
      for (const subId of clientSubs) {
        yield* subs.removeSub(connKey, subId)
      }
    })

    const handleMessage = (raw: string | Uint8Array) => {
      const data = typeof raw === "string" ? raw : new TextDecoder().decode(raw)
      return Effect.gen(function*() {
        const parseResult = yield* Schema.decodeUnknownEffect(
          Schema.UnknownFromJsonString,
        )(data).pipe(
          Effect.flatMap((msg) =>
            Array.isArray(msg) && msg.length > 0
              ? Effect.succeed(msg)
              : Effect.fail(new InvalidMessageError({ message: "Expected non-empty array" }))
          ),
          Effect.catchTag("InvalidMessageError", (err) =>
            Effect.gen(function*() {
              yield* Effect.logInfo("invalid message", err.message)
              yield* send(["NOTICE", "Invalid message"])
              return null
            })),
          Effect.catch((err: unknown) =>
            Effect.gen(function*() {
              yield* Effect.logInfo("parse error", err)
              yield* send(["NOTICE", "Invalid message"])
              return null
            })
          ),
        )
        if (parseResult === null) return

        const [type, ...args] = parseResult
        yield* Effect.logInfo(
          "incoming",
          type,
          args.length > 0 ? toJsonString(args).slice(0, 1000) + "..." : "",
        )

        const authState = yield* Ref.get(authStateRef)
        const isAuthed = !!authState.authenticatedPubkey
        if (config.requireAuth && !isAuthed && type !== "AUTH") {
          yield* send(["CLOSED", args[0] ?? "sub", `auth-required: ${authState.challenge}`])
          return
        }

        switch (type) {
          case "EVENT": {
            const eventId = getEventId(args[0])
            const sendOk = (accepted: boolean, msg: string) => send(["OK", eventId || "unknown", accepted, msg])

            const eventResult = yield* Schema.decodeUnknownEffect(NostrEventSchema)(args[0]).pipe(
              Effect.catch(() => Effect.succeed(null)),
            )
            if (!eventResult) {
              yield* Effect.logInfo("invalid event structure")
              yield* sendOk(false, "invalid: malformed event")
              return
            }

            if (!verifyEvent(eventResult as Parameters<typeof verifyEvent>[0])) {
              yield* Effect.logInfo("invalid event signature", { id: eventResult.id })
              yield* sendOk(false, "invalid: bad signature")
              return
            }

            if (config.bannedPubkeys.has(eventResult.pubkey)) {
              yield* Effect.logInfo("banned pubkey attempted to publish", {
                pubkey: eventResult.pubkey,
                id: eventResult.id,
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
                now,
              })
              yield* sendOk(false, "invalid: event creation date is too far off from the current time")
              return
            }

            const { duplicate } = yield* store.storeEvent(eventResult)

            yield* sendOk(true, duplicate ? "duplicate: already have this event" : "")

            if (!duplicate) {
              const matching = yield* subs.getMatchingSubs(eventResult)
              for (const m of matching) {
                if (m.send) {
                  yield* m.send(["EVENT", m.subId, eventResult])
                }
              }
            }
            break
          }

          case "REQ": {
            const subId = typeof args[0] === "string" ? args[0] : undefined
            if (!subId || subId.length === 0) {
              yield* send(["NOTICE", "invalid: subscription_id required"])
              return
            }
            if (subId.length > 64) {
              yield* send(["NOTICE", "invalid: subscription_id max 64 chars"])
              return
            }

            const filterInputs = args.slice(1) as unknown[]
            const filters_: NostrFilter[] = filterInputs.length > 0
              ? filterInputs.map((f: unknown) => parseFilter(f))
              : [{} as NostrFilter]

            const filterError = validateFilters(filters_)
            if (filterError) {
              yield* send(["NOTICE", filterError])
              return
            }

            yield* Ref.update(clientSubsRef, (s) => {
              const next = new Set(s)
              next.add(subId)
              return next
            })

            const historical = yield* subs.getHistoricalEvents(filters_, getEffectiveLimit(filters_))
            for (const ev of historical) {
              yield* send(["EVENT", subId, ev])
            }
            yield* send(["EOSE", subId])

            yield* subs.addSub(connKey, subId, filters_, send, isAuthed ? authState.authenticatedPubkey : undefined)
            break
          }

          case "AUTH": {
            const authEvent = args[0] as { kind?: number; id?: string; pubkey?: string; tags?: string[][] } | undefined
            if (!authEvent || authEvent.kind !== 22242) break

            const challenge = authState.challenge
            const hasChallenge = authEvent.tags?.some((t) => t[0] === "challenge" && t[1] === challenge)
            const hasRelay = authEvent.tags?.some((t) => t[0] === "relay" && t[1]?.includes(relayUrl))
            if (
              !verifyEvent(authEvent as Parameters<typeof verifyEvent>[0]) ||
              !hasChallenge ||
              !hasRelay
            ) {
              yield* send(["OK", authEvent.id ?? "", false, "invalid: auth verification failed"])
              break
            }

            yield* Ref.update(authStateRef, (s) => ({ ...s, authenticatedPubkey: authEvent.pubkey }))
            yield* send(["OK", authEvent.id ?? "", true, ""])
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
              yield* subs.removeSub(connKey, subId)
            }
            break
          }
        }
      })
    }

    yield* socket.runRaw(handleMessage, { onOpen: sendAuthOnOpen }).pipe(
      Effect.ensuring(removeClientFromSubs),
      Effect.catchCause((cause) =>
        Effect.gen(function*() {
          if (isGoingAwayClose(cause)) return
          yield* Effect.logInfo("connection error", cause)
        })
      ),
    )
  })
}

function makeProgram() {
  return Effect.gen(function*() {
    const store = yield* RelayStore
    const config = yield* RelayConfig
    const subsService = yield* SubscriptionService
    const { host, port } = config
    const relayUrl = `ws://${host}:${port}`

    const server = yield* NodeSocketServer.makeWebSocket({ host, port })
    yield* Effect.logInfo(`listening on ws://${host}:${port}`)
    yield* Effect.logInfo(`connect via: ws://localhost:${port} or ws://purple.local:${port}`)

    return yield* server
      .run((socket) => handleNostrConnection(socket, store, config, subsService, relayUrl).pipe(Effect.asVoid))
      .pipe(Effect.catch(() => Effect.void))
  }).pipe(Effect.annotateLogs("component", "relay"), Effect.scoped)
}

export const program = makeProgram()

export const inMemoryRelayLayer = Layer.mergeAll(
  RelayStoreLive,
  RelayConfigLive,
  Layer.provide(SubscriptionServiceMemoryLive, RelayStoreLive),
  ConfigProvider.layer(ConfigProvider.fromEnv()),
  DevTools.layer(),
  Logger.layer([Logger.consolePretty()]),
)
