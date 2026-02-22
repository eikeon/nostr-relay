/**
 * NIP-01 kind classification helpers
 */

import type { NostrEvent } from "./schema.js"

export function isReplaceable(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000)
}

export function isEphemeral(kind: number): boolean {
  return kind >= 20000 && kind < 30000
}

export function isAddressable(kind: number): boolean {
  return kind >= 30000 && kind < 40000
}

export function isRegular(kind: number): boolean {
  return kind >= 1000 && kind < 10000
}

export function replaceableKey(event: NostrEvent): string {
  return `${event.pubkey}:${event.kind}`
}

export function addressableKey(event: NostrEvent): string {
  const dTag = event.tags.find((t) => t[0] === "d")
  const d = dTag?.[1] ?? ""
  return `${event.kind}:${event.pubkey}:${d}`
}

/** Compare two events for replaceable semantics: keep newer, tie-break by lowest id */
export function shouldReplace(existing: NostrEvent, incoming: NostrEvent): boolean {
  if (incoming.created_at > existing.created_at) return true
  if (incoming.created_at < existing.created_at) return false
  return incoming.id < existing.id
}
