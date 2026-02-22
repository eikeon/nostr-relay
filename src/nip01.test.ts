/**
 * Unit tests for NIP-01 kind classification helpers
 */

import { describe, expect, it } from "@effect/vitest"
import {
  addressableKey,
  isAddressable,
  isEphemeral,
  isRegular,
  isReplaceable,
  replaceableKey,
  shouldReplace
} from "./nip01.js"
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
    ...overrides
  }
}

describe("isReplaceable", () => {
  it("returns true for kind 0 and 3", () => {
    expect(isReplaceable(0)).toBe(true)
    expect(isReplaceable(3)).toBe(true)
  })

  it("returns true for kinds 10000-19999", () => {
    expect(isReplaceable(10000)).toBe(true)
    expect(isReplaceable(15000)).toBe(true)
    expect(isReplaceable(19999)).toBe(true)
  })

  it("returns false for other kinds", () => {
    expect(isReplaceable(1)).toBe(false)
    expect(isReplaceable(9999)).toBe(false)
    expect(isReplaceable(20000)).toBe(false)
  })
})

describe("isEphemeral", () => {
  it("returns true for kinds 20000-29999", () => {
    expect(isEphemeral(20000)).toBe(true)
    expect(isEphemeral(25000)).toBe(true)
    expect(isEphemeral(29999)).toBe(true)
  })

  it("returns false for other kinds", () => {
    expect(isEphemeral(19999)).toBe(false)
    expect(isEphemeral(30000)).toBe(false)
  })
})

describe("isAddressable", () => {
  it("returns true for kinds 30000-39999", () => {
    expect(isAddressable(30000)).toBe(true)
    expect(isAddressable(35000)).toBe(true)
    expect(isAddressable(39999)).toBe(true)
  })

  it("returns false for other kinds", () => {
    expect(isAddressable(29999)).toBe(false)
    expect(isAddressable(40000)).toBe(false)
  })
})

describe("isRegular", () => {
  it("returns true for kinds 1000-9999", () => {
    expect(isRegular(1000)).toBe(true)
    expect(isRegular(5000)).toBe(true)
    expect(isRegular(9999)).toBe(true)
  })

  it("returns false for other kinds", () => {
    expect(isRegular(999)).toBe(false)
    expect(isRegular(10000)).toBe(false)
  })
})

describe("replaceableKey", () => {
  it("returns pubkey:kind", () => {
    const event = makeEvent({ pubkey: "b".repeat(64), kind: 0 })
    expect(replaceableKey(event)).toBe("b".repeat(64) + ":0")
  })
})

describe("addressableKey", () => {
  it("returns kind:pubkey:d when d tag present", () => {
    const event = makeEvent({
      kind: 30023,
      pubkey: "b".repeat(64),
      tags: [["d", "my-identifier"]]
    })
    expect(addressableKey(event)).toBe("30023:" + "b".repeat(64) + ":my-identifier")
  })

  it("returns kind:pubkey: when d tag absent", () => {
    const event = makeEvent({
      kind: 30023,
      pubkey: "b".repeat(64),
      tags: []
    })
    expect(addressableKey(event)).toBe("30023:" + "b".repeat(64) + ":")
  })
})

describe("shouldReplace", () => {
  it("returns true when incoming is newer", () => {
    const existing = makeEvent({ created_at: 100, id: "a" })
    const incoming = makeEvent({ created_at: 200, id: "b" })
    expect(shouldReplace(existing, incoming)).toBe(true)
  })

  it("returns false when incoming is older", () => {
    const existing = makeEvent({ created_at: 200, id: "a" })
    const incoming = makeEvent({ created_at: 100, id: "b" })
    expect(shouldReplace(existing, incoming)).toBe(false)
  })

  it("tie-breaks by id when created_at equal", () => {
    const existing = makeEvent({ created_at: 100, id: "b" })
    const incoming = makeEvent({ created_at: 100, id: "a" })
    expect(shouldReplace(existing, incoming)).toBe(true)
    expect(shouldReplace(incoming, existing)).toBe(false)
  })
})
