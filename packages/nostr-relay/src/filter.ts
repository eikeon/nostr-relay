/**
 * NIP-01 filter matching and validation
 */

import { HEX64, SINGLE_LETTER_TAG } from "./constants.js"
import type { NostrEvent, NostrFilter } from "./schema.js"

export function getTagValues(event: NostrEvent, tagName: string): string[] {
  return event.tags
    .filter((t) => t[0] === tagName && t[1])
    .map((t) => t[1] as string)
}

export function matchesTagFilter(event: NostrEvent, filterKey: string, filterValues: readonly string[]): boolean {
  if (filterValues.length === 0) return true
  const tagName = filterKey.startsWith("#") ? filterKey.slice(1) : filterKey
  if (tagName.length !== 1) return true
  const eventValues = getTagValues(event, tagName)
  return eventValues.some((v) => filterValues.includes(v))
}

export function matchesFilter(event: NostrEvent, filters: NostrFilter[]): boolean {
  if (filters.length === 0) return true
  for (const f of filters) {
    if (f.kinds && f.kinds.length > 0 && !f.kinds.includes(event.kind)) {
      continue
    }
    if (f.authors && f.authors.length > 0 && !f.authors.includes(event.pubkey)) {
      continue
    }
    if (f.ids && f.ids.length > 0 && !f.ids.includes(event.id)) continue
    if (f.since !== undefined && event.created_at < f.since) continue
    if (f.until !== undefined && event.created_at > f.until) continue
    let tagMatch = true
    for (const key of Object.keys(f)) {
      if (SINGLE_LETTER_TAG.test(key)) {
        const vals = f[key]
        if (Array.isArray(vals)) {
          const strVals = vals.filter((v): v is string => typeof v === "string")
          if (strVals.length > 0 && !matchesTagFilter(event, key, strVals)) {
            tagMatch = false
            break
          }
        }
      }
    }
    if (!tagMatch) continue
    return true
  }
  return false
}

export function isValidHex64Array(arr: readonly string[] | undefined): boolean {
  if (!arr || arr.length === 0) return true
  return arr.every((s) => HEX64.test(s))
}

export function getEffectiveLimit(filters: NostrFilter[]): number {
  const limits = filters.map((f) => f.limit).filter((n): n is number => typeof n === "number")
  if (limits.length === 0) return 100
  return Math.max(...limits)
}

export function validateFilters(filters: NostrFilter[]): string | null {
  for (const f of filters) {
    if (!isValidHex64Array(f.ids)) return "invalid: ids must be 64-char lowercase hex"
    if (!isValidHex64Array(f.authors)) return "invalid: authors must be 64-char lowercase hex"
    if (f["#e"] && !isValidHex64Array(f["#e"])) return "invalid: #e must be 64-char lowercase hex"
    if (f["#p"] && !isValidHex64Array(f["#p"])) return "invalid: #p must be 64-char lowercase hex"
  }
  return null
}
