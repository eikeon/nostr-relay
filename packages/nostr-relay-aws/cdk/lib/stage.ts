import * as cdk from "aws-cdk-lib"
import { NostrRelayStack } from "./nostr-relay-stack.js"

export class NostrRelayStage extends cdk.Stage {
  constructor(scope: cdk.App, id: string, props?: cdk.StageProps) {
    super(scope, id, props)
    new NostrRelayStack(this, "NostrRelay")
  }
}
