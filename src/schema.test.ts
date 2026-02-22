/**
 * Unit tests for schema and parseFilter
 */

import { describe, expect, it } from "@effect/vitest"
import { parseFilter } from "./schema.js"

describe("parseFilter", () => {
  it("returns empty object for null or non-object", () => {
    expect(parseFilter(null)).toEqual({})
    expect(parseFilter(undefined)).toEqual({})
    expect(parseFilter("string")).toEqual({})
    expect(parseFilter(123)).toEqual({})
  })

  it("parses ids, authors, kinds", () => {
    const raw = {
      ids: ["a".repeat(64), "b".repeat(64), 123],
      authors: ["c".repeat(64)],
      kinds: [0, 1, 3.14]
    }
    const result = parseFilter(raw)
    expect(result.ids).toEqual(["a".repeat(64), "b".repeat(64)])
    expect(result.authors).toEqual(["c".repeat(64)])
    expect(result.kinds).toEqual([0, 1])
  })

  it("parses since, until, limit", () => {
    const raw = { since: 1000, until: 2000, limit: 10 }
    const result = parseFilter(raw)
    expect(result.since).toBe(1000)
    expect(result.until).toBe(2000)
    expect(result.limit).toBe(10)
  })

  it("parses single-letter tag filters", () => {
    const raw = {
      "#e": ["event1", "event2"],
      "#p": ["pubkey1"],
      "#r": ["relay1", 123]
    }
    const result = parseFilter(raw)
    expect(result["#e"]).toEqual(["event1", "event2"])
    expect(result["#p"]).toEqual(["pubkey1"])
    expect(result["#r"]).toEqual(["relay1"])
  })

  it("ignores non-single-letter tag keys", () => {
    const raw = { "#ee": ["x"], "#": ["y"] }
    const result = parseFilter(raw)
    expect(result["#ee"]).toBeUndefined()
    expect(result["#"]).toBeUndefined()
  })
})
