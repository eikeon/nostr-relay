import * as cdk from "aws-cdk-lib"

import { NostrRelayStack } from "../lib/nostr-relay-stack.js"

const app = new cdk.App()

new NostrRelayStack(app, "NostrRelay", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
})
