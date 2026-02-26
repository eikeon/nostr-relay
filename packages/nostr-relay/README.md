# @eikeon/nostr-relay

NIP-01 NOSTR relay - WebSocket server built with Effect v4.

## Overview

NOSTR is a decentralized protocol for social applications. This relay implements a NIP-01 WebSocket server using Effect v4. Events are stored in memory only (no persistence).

## NIPs Implemented

- **NIP-01** ([spec](https://github.com/nostr-protocol/nips/blob/master/01.md))
  - **Events**: schema validation (id, pubkey, created_at, kind, tags, content, sig)
  - **Filters**: ids, authors, kinds, since, until, limit, and single-letter tag filters (#e, #p, #a, etc.)
  - **Kind semantics**: replaceable (0, 3, 10000–19999), ephemeral (20000–29999), addressable (30000–39999), regular (1000–9999)
  - **Protocol**: REQ, EVENT, CLOSE message handling

## Requirements

- Node.js >= 24.0.0

## Run from npm

```bash
npx @eikeon/nostr-relay
```

Connects at `ws://localhost:8181`. Or install globally:

```bash
npm install -g @eikeon/nostr-relay
nostr-relay
```

## Develop from source

This is a pnpm monorepo. The in-memory relay lives in `packages/nostr-relay`; the AWS serverless implementation is in `packages/nostr-relay-aws`.

```bash
git clone https://github.com/eikeon/nostr-relay.git
cd nostr-relay
pnpm install
pnpm run dev
```

### Scripts

| Script           | Purpose                          |
| ---------------- | -------------------------------- |
| `pnpm run dev`   | Start relay (tsx)                |
| `pnpm run build` | Compile TypeScript               |
| `pnpm run start` | Run compiled relay               |
| `pnpm run test`  | Run vitest                       |
| `pnpm run smoke` | Verify relay starts on port 8182 |
| `pnpm run lint`  | ESLint + tsc check               |

For production: `pnpm run build && pnpm run start`.

## Configuration

- `RELAY_PORT` - Port to listen on (default: 8181)
- `RELAY_HOST` - Host to bind (default: 0.0.0.0)
- `RELAY_CREATED_AT_WINDOW_SEC` - Max seconds event created_at can differ from now (default: 900)
- `RELAY_BANNED_PUBKEYS` - Comma-separated 64-char hex pubkeys to ban (default: empty)

## See also

- [@eikeon/nostr-relay-aws](https://www.npmjs.com/package/@eikeon/nostr-relay-aws) - AWS serverless implementation (DynamoDB, Lambda, API Gateway WebSocket)

## License

MIT License (see [LICENSE](LICENSE)).
