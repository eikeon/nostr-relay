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

With a custom domain, a minimal CloudFront distribution is added to serve [NIP-11](https://github.com/nostr-protocol/nips/blob/master/11.md) relay metadata at the same hostname. Optional NIP-11 context overrides:

```bash
pnpm cdk deploy -c domainName=relay.eikeon.com \
  -c certificateArn=arn:aws:acm:us-east-1:ACCOUNT:certificate/ID \
  -c hostedZoneDomain=eikeon.com \
  -c nip11Name="eikeon Learn Relay" \
  -c nip11Description="Interactive vocabulary exercises & multi-learner sessions on Nostr. Visit https://learn.eikeon.com" \
  -c nip11Icon="https://learn.eikeon.com/favicon.ico" \
  -c nip11Pubkey="npub1..." \
  -c nip11Contact="https://learn.eikeon.com"
```

`nip11Pubkey` accepts npub (auto-converted to hex per NIP-11) or 64-char hex.

Test NIP-11:

```bash
# NIP-11 via GET
curl -H "Accept: application/nostr+json" https://relay.eikeon.com

# CORS preflight (OPTIONS)
curl -X OPTIONS -H "Origin: https://example.com" -H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: Accept" -i https://relay.eikeon.com
```

Expected: OPTIONS returns 204 with CORS headers; GET returns 200 with JSON.

## Backfilling time_pk GSI

If you had existing events before adding the `time_pk-created_at-index` GSI, run the backfill script once to add the `time_pk` attribute so they appear in the index:

```bash
EVENTS_TABLE=YourEventsTable npx tsx scripts/backfill-time-pk.ts
```
