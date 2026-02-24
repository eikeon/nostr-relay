/**
 * @eikeon/nostr-relay-aws - AWS serverless implementation (DynamoDB, Lambda, API Gateway WebSocket)
 */

export { DynamoConfigLive, DynamoConfigService, RelayStoreDynamoLive } from "./relay-store-dynamodb.js"
export { SubscriptionServiceDynamoLive } from "./services/index.js"
