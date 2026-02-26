import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb"
import type { APIGatewayProxyWebsocketEventV2 } from "aws-lambda"

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}))

export const handler = async (event: APIGatewayProxyWebsocketEventV2) => {
  const connId = event.requestContext.connectionId!
  const challenge = crypto.randomUUID()
  await docClient.send(
    new PutCommand({
      TableName: process.env.SUBS_TABLE!,
      Item: {
        connectionId: connId,
        subId: "__challenge",
        challenge,
        ttl: Math.floor(Date.now() / 1000) + 86400,
      },
    }),
  )
  return { statusCode: 200 }
}
