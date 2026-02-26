/**
 * NIP-01 schemas for Nostr event and filter validation
 */

import { Schema } from "effect"
import { HEX64, SINGLE_LETTER_TAG } from "./constants.js"

const HEX128 = /^[a-f0-9]{128}$/

const isHex64 = Schema.makeFilter((s: string) => HEX64.test(s), {
  expected: "64-char lowercase hex string",
})
const isHex128 = Schema.makeFilter((s: string) => HEX128.test(s), {
  expected: "128-char lowercase hex string",
})

/** NIP-01 event structure */
export const NostrEventSchema = Schema.Struct({
  id: Schema.String.pipe(Schema.check(isHex64)),
  pubkey: Schema.String.pipe(Schema.check(isHex64)),
  created_at: Schema.Number,
  kind: Schema.Number.pipe(
    Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 65535 })),
  ),
  tags: Schema.Array(Schema.Array(Schema.String)),
  content: Schema.String,
  sig: Schema.String.pipe(Schema.check(isHex128)),
})

export type NostrEvent = Schema.Schema.Type<typeof NostrEventSchema>

/** NIP-01 filter - optional fields for subscription matching. Tag filters #e, #p, #a and any #<letter> use first tag value. */
export const NostrFilterSchema = Schema.Struct({
  ids: Schema.optionalKey(Schema.Array(Schema.String)),
  authors: Schema.optionalKey(Schema.Array(Schema.String)),
  kinds: Schema.optionalKey(Schema.Array(Schema.Number)),
  since: Schema.optionalKey(Schema.Number),
  until: Schema.optionalKey(Schema.Number),
  limit: Schema.optionalKey(Schema.Number),
  "#e": Schema.optionalKey(Schema.Array(Schema.String)),
  "#p": Schema.optionalKey(Schema.Array(Schema.String)),
  "#a": Schema.optionalKey(Schema.Array(Schema.String)),
})

export type NostrFilter = Schema.Schema.Type<typeof NostrFilterSchema> & {
  [key: string]: string[] | number[] | number | undefined
}

/** Parse filter from raw object, preserving arbitrary single-letter tag filters (#e, #p, #a, #r, etc.) */
export function parseFilter(raw: unknown): NostrFilter {
  if (typeof raw !== "object" || raw === null) return {}
  const obj = raw as Record<string, unknown>
  const result: Record<string, unknown> = {}
  if (Array.isArray(obj.ids)) {
    result.ids = obj.ids.filter((x): x is string => typeof x === "string")
  }
  if (Array.isArray(obj.authors)) {
    result.authors = obj.authors.filter((x): x is string => typeof x === "string")
  }
  if (Array.isArray(obj.kinds)) {
    result.kinds = obj.kinds.filter(
      (x): x is number => typeof x === "number" && Number.isInteger(x),
    )
  }
  if (typeof obj.since === "number") result.since = obj.since
  if (typeof obj.until === "number") result.until = obj.until
  if (typeof obj.limit === "number") result.limit = obj.limit
  for (const key of Object.keys(obj)) {
    if (SINGLE_LETTER_TAG.test(key) && Array.isArray(obj[key])) {
      result[key] = (obj[key] as unknown[]).filter(
        (x): x is string => typeof x === "string",
      )
    }
  }
  return result as NostrFilter
}
