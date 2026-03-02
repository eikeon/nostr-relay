import { Logger } from "@aws-lambda-powertools/logger"
import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb"
import type { APIGatewayProxyWebsocketEventV2 } from "aws-lambda"

const logger = new Logger({ serviceName: "nostr-relay" })
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}))

export const handler = async (event: APIGatewayProxyWebsocketEventV2) => {
  const connId = event.requestContext.connectionId!
  const subsTable = process.env.SUBS_TABLE
  if (!subsTable) {
    logger.error("connect failed: SUBS_TABLE env not set")
    return { statusCode: 500 }
  }
  const challenge = crypto.randomUUID()
  try {
    await docClient.send(
      new PutCommand({
        TableName: subsTable,
        Item: {
          connectionId: connId,
          subId: "__challenge",
          challenge,
          ttl: Math.floor(Date.now() / 1000) + 86400,
        },
      }),
    )
    return { statusCode: 200 }
  } catch (err) {
    logger.error("connect failed", { connectionId: connId, error: err })
    return { statusCode: 500 }
  }
}
