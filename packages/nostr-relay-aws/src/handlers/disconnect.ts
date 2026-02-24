import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DeleteCommand, DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb"
import type { APIGatewayProxyWebsocketEventV2 } from "aws-lambda"

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}))

export const handler = async (event: APIGatewayProxyWebsocketEventV2) => {
  const connId = event.requestContext.connectionId!
  const subsTable = process.env.SUBS_TABLE!

  const res = await docClient.send(
    new QueryCommand({
      TableName: subsTable,
      KeyConditionExpression: "connectionId = :cid",
      ExpressionAttributeValues: { ":cid": connId },
    }),
  )

  const items = res.Items ?? []
  for (const item of items) {
    await docClient.send(
      new DeleteCommand({
        TableName: subsTable,
        Key: { connectionId: connId, subId: item.subId },
      }),
    )
  }

  return { statusCode: 200 }
}
