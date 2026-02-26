# @eikeon/nostr-relay-aws

NIP-01 NOSTR relay - AWS serverless implementation (DynamoDB, Lambda, API Gateway WebSocket).

Requires [@eikeon/nostr-relay](https://www.npmjs.com/package/@eikeon/nostr-relay) as a peer dependency.

## Requirements

- Node.js >= 24.0.0
- AWS account for DynamoDB and API Gateway

## CDK Deployment

```bash
cd packages/nostr-relay-aws
pnpm cdk bootstrap
pnpm cdk deploy
```

By default you get the API Gateway URL (`wss://{apiId}.execute-api.{region}.amazonaws.com/prod`). For a custom domain (e.g. `wss://relay.example.com`), pass context at deploy time:

```bash
pnpm cdk deploy -c domainName=relay.example.com -c certificateArn=arn:aws:acm:us-east-1:ACCOUNT:certificate/ID -c hostedZoneDomain=example.com
```

You need an ACM certificate in `us-east-1` and a Route53 hosted zone for the domain.
