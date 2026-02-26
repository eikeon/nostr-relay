/**
 * Unit tests for filter matching and validation
 */

import { describe, expect, it } from "@effect/vitest"
import { getTagValues, isValidHex64Array, matchesFilter, matchesTagFilter, validateFilters } from "./filter.js"
import type { NostrEvent } from "./schema.js"

const HEX64 = "a".repeat(64)
const HEX128 = "a".repeat(128)

function makeEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: HEX64,
    pubkey: HEX64,
    created_at: 1700000000,
    kind: 1,
    tags: [],
    content: "",
    sig: HEX128,
    ...overrides,
  }
}

describe("getTagValues", () => {
  it("returns values for matching tag", () => {
    const event = makeEvent({ tags: [["e", "abc"], ["e", "def"], ["p", "xyz"]] })
    expect(getTagValues(event, "e")).toEqual(["abc", "def"])
    expect(getTagValues(event, "p")).toEqual(["xyz"])
  })

  it("returns empty array when no matching tags", () => {
    const event = makeEvent({ tags: [["e", "abc"]] })
    expect(getTagValues(event, "p")).toEqual([])
  })

  it("skips tags with empty value", () => {
    const event = makeEvent({ tags: [["e", "abc"], ["e", ""], ["e"]] })
    expect(getTagValues(event, "e")).toEqual(["abc"])
  })
})

describe("matchesTagFilter", () => {
  it("returns true when filter values empty", () => {
    const event = makeEvent({ tags: [["e", "abc"]] })
    expect(matchesTagFilter(event, "#e", [])).toBe(true)
  })

  it("returns true when event has matching tag value", () => {
    const event = makeEvent({ tags: [["e", "abc"]] })
    expect(matchesTagFilter(event, "#e", ["abc"])).toBe(true)
    expect(matchesTagFilter(event, "#e", ["xyz", "abc"])).toBe(true)
  })

  it("returns false when event has no matching tag value", () => {
    const event = makeEvent({ tags: [["e", "abc"]] })
    expect(matchesTagFilter(event, "#e", ["xyz"])).toBe(false)
  })

  it("accepts # prefix in filter key", () => {
    const event = makeEvent({ tags: [["e", "abc"]] })
    expect(matchesTagFilter(event, "#e", ["abc"])).toBe(true)
  })

  it("returns true for non-single-letter tag (ignored)", () => {
    const event = makeEvent({ tags: [["subject", "foo"]] })
    expect(matchesTagFilter(event, "#subject", ["foo"])).toBe(true)
  })
})

describe("matchesFilter", () => {
  it("returns true when filters empty", () => {
    const event = makeEvent()
    expect(matchesFilter(event, [])).toBe(true)
  })

  it("matches on kinds", () => {
    const event = makeEvent({ kind: 1 })
    expect(matchesFilter(event, [{ kinds: [1] }])).toBe(true)
    expect(matchesFilter(event, [{ kinds: [0, 1, 2] }])).toBe(true)
    expect(matchesFilter(event, [{ kinds: [0] }])).toBe(false)
  })

  it("matches on authors", () => {
    const event = makeEvent({ pubkey: HEX64 })
    expect(matchesFilter(event, [{ authors: [HEX64] }])).toBe(true)
    expect(matchesFilter(event, [{ authors: ["b".repeat(64)] }])).toBe(false)
  })

  it("matches on ids", () => {
    const event = makeEvent({ id: HEX64 })
    expect(matchesFilter(event, [{ ids: [HEX64] }])).toBe(true)
    expect(matchesFilter(event, [{ ids: ["b".repeat(64)] }])).toBe(false)
  })

  it("matches on since/until", () => {
    const event = makeEvent({ created_at: 1700000000 })
    expect(matchesFilter(event, [{ since: 1699999999 }])).toBe(true)
    expect(matchesFilter(event, [{ since: 1700000001 }])).toBe(false)
    expect(matchesFilter(event, [{ until: 1700000001 }])).toBe(true)
    expect(matchesFilter(event, [{ until: 1699999999 }])).toBe(false)
  })

  it("matches on #e and #p tags", () => {
    const event = makeEvent({ tags: [["e", "abc123"], ["p", "def456"]] })
    expect(matchesFilter(event, [{ "#e": ["abc123"] }])).toBe(true)
    expect(matchesFilter(event, [{ "#p": ["def456"] }])).toBe(true)
    expect(matchesFilter(event, [{ "#e": ["xyz"] }])).toBe(false)
  })

  it("returns true if any filter matches (OR semantics)", () => {
    const event = makeEvent({ kind: 1 })
    expect(matchesFilter(event, [{ kinds: [0] }, { kinds: [1] }])).toBe(true)
    expect(matchesFilter(event, [{ kinds: [0] }, { kinds: [2] }])).toBe(false)
  })
})

describe("isValidHex64Array", () => {
  it("returns true for undefined or empty", () => {
    expect(isValidHex64Array(undefined)).toBe(true)
    expect(isValidHex64Array([])).toBe(true)
  })

  it("returns true when all valid hex64", () => {
    expect(isValidHex64Array([HEX64])).toBe(true)
    expect(isValidHex64Array([HEX64, "b".repeat(64)])).toBe(true)
  })

  it("returns false when any invalid", () => {
    expect(isValidHex64Array(["short"])).toBe(false)
    expect(isValidHex64Array([HEX64 + "x"])).toBe(false)
    expect(isValidHex64Array(["ABC" + "a".repeat(61)])).toBe(false)
  })
})

describe("validateFilters", () => {
  it("returns null for valid filters", () => {
    expect(validateFilters([{}])).toBe(null)
    expect(validateFilters([{ ids: [HEX64], authors: [HEX64] }])).toBe(null)
  })

  it("returns error for invalid ids", () => {
    expect(validateFilters([{ ids: ["bad"] }])).toBe("invalid: ids must be 64-char lowercase hex")
  })

  it("returns error for invalid authors", () => {
    expect(validateFilters([{ authors: ["bad"] }])).toBe("invalid: authors must be 64-char lowercase hex")
  })

  it("returns error for invalid #e", () => {
    expect(validateFilters([{ "#e": ["bad"] }])).toBe("invalid: #e must be 64-char lowercase hex")
  })

  it("returns error for invalid #p", () => {
    expect(validateFilters([{ "#p": ["bad"] }])).toBe("invalid: #p must be 64-char lowercase hex")
  })
})
