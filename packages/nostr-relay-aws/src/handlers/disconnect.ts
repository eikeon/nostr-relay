import { Logger } from "@aws-lambda-powertools/logger"
import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DeleteCommand, DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb"
import type { NostrFilter } from "@eikeon/nostr-relay/schema"
import type { APIGatewayProxyWebsocketEventV2 } from "aws-lambda"

const logger = new Logger({ serviceName: "nostr-relay" })
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const MATCH_ALL_KINDS = -1

function getKindsFromFilters(filters: NostrFilter[]): number[] {
  const kinds = new Set<number>()
  for (const f of filters) {
    if (f.kinds && f.kinds.length > 0) {
      for (const k of f.kinds) kinds.add(k)
    } else {
      kinds.add(MATCH_ALL_KINDS)
    }
  }
  return [...kinds]
}

export const handler = async (event: APIGatewayProxyWebsocketEventV2) => {
  const connId = event.requestContext.connectionId!
  const subsTable = process.env.SUBS_TABLE
  const subsKindIndexTable = process.env.SUBS_KIND_INDEX_TABLE
  if (!subsTable) {
    logger.error("disconnect failed: SUBS_TABLE env not set")
    return { statusCode: 500 }
  }

  let res
  try {
    res = await docClient.send(
      new QueryCommand({
        TableName: subsTable,
        KeyConditionExpression: "connectionId = :cid",
        ExpressionAttributeValues: { ":cid": connId },
      }),
    )
  } catch (err) {
    logger.error("disconnect failed: Query subs", { connectionId: connId, error: err })
    return { statusCode: 500 }
  }

  const items = res.Items ?? []
  for (const item of items) {
    const subId = item.subId as string
    if (subsKindIndexTable && item.filter) {
      try {
        const filters = JSON.parse(item.filter as string) as NostrFilter[]
        const kinds = getKindsFromFilters(Array.isArray(filters) ? filters : [filters])
        const connectionIdSubId = `${connId}#${subId}`
        for (const kind of kinds) {
          try {
            await docClient.send(
              new DeleteCommand({
                TableName: subsKindIndexTable,
                Key: { kind, connectionIdSubId },
              }),
            )
          } catch (err) {
            logger.warn("disconnect: failed to delete from kind index", {
              connectionId: connId,
              subId,
              kind,
              error: err,
            })
          }
        }
      } catch {
        // ignore parse errors
      }
    }
    try {
      await docClient.send(
        new DeleteCommand({
          TableName: subsTable,
          Key: { connectionId: connId, subId },
        }),
      )
    } catch (err) {
      logger.warn("disconnect: failed to delete sub", { connectionId: connId, subId, error: err })
    }
  }

  return { statusCode: 200 }
}
