#!/usr/bin/env npx tsx
/**
 * Backfill time_pk on existing events for the time_pk-created_at-index GSI.
 * Run once after deploying the GSI if you have existing data.
 *
 * Usage: EVENTS_TABLE=YourEventsTable npx tsx scripts/backfill-time-pk.ts
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb"

const tableName = process.env.EVENTS_TABLE ?? "EventsTable"
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}))

async function backfill() {
  let lastKey: Record<string, unknown> | undefined
  let total = 0
  let updated = 0
  do {
    const res = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: "id, time_pk",
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }),
    )
    lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined
    const items = res.Items ?? []
    total += items.length

    for (const item of items) {
      if (item.time_pk === "event") continue
      await docClient.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { id: item.id },
          UpdateExpression: "SET time_pk = :pk",
          ExpressionAttributeValues: { ":pk": "event" },
        }),
      )
      updated++
    }
    process.stdout.write(`\rScanned ${total}, updated ${updated}...`)
  } while (lastKey)

  console.log(`\nDone. Total: ${total}, updated: ${updated}`)
}

backfill().catch((err) => {
  console.error(err)
  process.exit(1)
})
