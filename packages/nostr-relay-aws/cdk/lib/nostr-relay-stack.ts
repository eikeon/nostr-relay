import * as cdk from "aws-cdk-lib"
import { Duration } from "aws-cdk-lib"
import { WebSocketApi, WebSocketStage } from "aws-cdk-lib/aws-apigatewayv2"
import { WebSocketLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations"
import * as acm from "aws-cdk-lib/aws-certificatemanager"
import * as cloudfront from "aws-cdk-lib/aws-cloudfront"
import * as cloudfrontOrigins from "aws-cdk-lib/aws-cloudfront-origins"
import { AttributeType, BillingMode, ProjectionType, Table } from "aws-cdk-lib/aws-dynamodb"
import { Runtime } from "aws-cdk-lib/aws-lambda"
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs"
import * as route53 from "aws-cdk-lib/aws-route53"
import * as route53_targets from "aws-cdk-lib/aws-route53-targets"
import type { Construct } from "constructs"
import { readFileSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))

export class NostrRelayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    const eventsTable = new Table(this, "EventsTable", {
      partitionKey: { name: "id", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    })
    eventsTable.addGlobalSecondaryIndex({
      indexName: "pubkey-created_at-index",
      partitionKey: { name: "pubkey", type: AttributeType.STRING },
      sortKey: { name: "created_at", type: AttributeType.NUMBER },
      projectionType: ProjectionType.ALL,
    })

    const subsTable = new Table(this, "SubscriptionsTable", {
      partitionKey: { name: "connectionId", type: AttributeType.STRING },
      sortKey: { name: "subId", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: "ttl",
    })

    const connectFn = new NodejsFunction(this, "ConnectFn", {
      entry: "src/handlers/connect.ts",
      runtime: Runtime.NODEJS_24_X,
      environment: { SUBS_TABLE: subsTable.tableName },
      timeout: Duration.seconds(10),
    })
    const disconnectFn = new NodejsFunction(this, "DisconnectFn", {
      entry: "src/handlers/disconnect.ts",
      runtime: Runtime.NODEJS_24_X,
      environment: { SUBS_TABLE: subsTable.tableName },
      timeout: Duration.seconds(10),
    })
    const defaultFn = new NodejsFunction(this, "DefaultFn", {
      entry: "src/handlers/default.ts",
      runtime: Runtime.NODEJS_24_X,
      environment: {
        EVENTS_TABLE: eventsTable.tableName,
        SUBS_TABLE: subsTable.tableName,
        RELAY_REQUIRE_AUTH: "false",
        RELAY_BANNED_PUBKEYS: process.env.RELAY_BANNED_PUBKEYS ?? "",
        RELAY_CREATED_AT_WINDOW_SEC: process.env.RELAY_CREATED_AT_WINDOW_SEC ?? "900",
      },
      timeout: Duration.seconds(30),
      memorySize: 512,
    })
    ;[eventsTable, subsTable].forEach((t) => t.grantReadWriteData(defaultFn))
    subsTable.grantReadWriteData(connectFn)
    subsTable.grantReadWriteData(disconnectFn)

    const wsApi = new WebSocketApi(this, "NostrRelayApi", {
      connectRouteOptions: { integration: new WebSocketLambdaIntegration("Connect", connectFn) },
      disconnectRouteOptions: { integration: new WebSocketLambdaIntegration("Disconnect", disconnectFn) },
    })
    wsApi.addRoute("$default", {
      integration: new WebSocketLambdaIntegration("DefaultRoute", defaultFn),
    })
    wsApi.grantManageConnections(defaultFn)

    const _prodStage = new WebSocketStage(this, "ProdStage", {
      webSocketApi: wsApi,
      stageName: "prod",
      autoDeploy: true,
    })

    new cdk.CfnOutput(this, "WebSocketUrl", { value: wsApi.apiEndpoint + "/prod" })

    const domainName = this.node.tryGetContext("domainName") as string | undefined
    const certificateArn = this.node.tryGetContext("certificateArn") as string | undefined
    const hostedZoneDomain = this.node.tryGetContext("hostedZoneDomain") as string | undefined

    if (domainName && certificateArn && hostedZoneDomain) {
      const nip11Name = (this.node.tryGetContext("nip11Name") as string | undefined) ?? "eikeon Learn Relay"
      const nip11Description = (this.node.tryGetContext("nip11Description") as string | undefined) ??
        "Interactive vocabulary exercises & multi-learner sessions on Nostr. Visit https://learn.eikeon.com"
      const nip11Icon = (this.node.tryGetContext("nip11Icon") as string | undefined) ??
        "https://learn.eikeon.com/favicon.ico"
      const nip11Banner = this.node.tryGetContext("nip11Banner") as string | undefined
      const nip11Pubkey = this.node.tryGetContext("nip11Pubkey") as string | undefined
      const nip11Contact = (this.node.tryGetContext("nip11Contact") as string | undefined) ?? "https://learn.eikeon.com"
      const nip11SupportedNips = (this.node.tryGetContext("nip11SupportedNips") as number[] | undefined) ?? [
        1,
        11,
        42,
      ]

      const pkgPath = join(__dirname, "../../package.json")
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string }
      const nip11Version = pkg.version ?? "2.0.0"

      const nip11Json = JSON.stringify({
        name: nip11Name,
        description: nip11Description,
        icon: nip11Icon,
        ...(nip11Banner && { banner: nip11Banner }),
        ...(nip11Pubkey && { pubkey: nip11Pubkey }),
        contact: nip11Contact,
        supported_nips: nip11SupportedNips,
        software: "@eikeon/nostr-relay",
        version: nip11Version,
      })

      const nip11Function = new cloudfront.Function(this, "Nip11Function", {
        code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var req = event.request;
  var upgrade = (req.headers && req.headers.upgrade && req.headers.upgrade.value) ? req.headers.upgrade.value.toLowerCase() : '';
  if (upgrade === 'websocket') return req;
  var accept = (req.headers && req.headers.accept && req.headers.accept.value) ? req.headers.accept.value : '';
  if (accept.indexOf('application/nostr+json') !== -1) {
    return {
      statusCode: 200,
      statusDescription: 'OK',
      headers: {
        'content-type': { value: 'application/json' },
        'access-control-allow-origin': { value: '*' },
        'cache-control': { value: 'public, max-age=3600' }
      },
      body: ${JSON.stringify(nip11Json)}
    };
  }
  return req;
}
`),
      })

      const originDomain = `${wsApi.apiId}.execute-api.${this.region}.amazonaws.com`
      const distribution = new cloudfront.Distribution(this, "RelayDistribution", {
        defaultBehavior: {
          origin: new cloudfrontOrigins.HttpOrigin(originDomain, { originPath: "/prod" }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          functionAssociations: [
            {
              function: nip11Function,
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            },
          ],
        },
        domainNames: [domainName],
        certificate: acm.Certificate.fromCertificateArn(this, "Cert", certificateArn),
      })

      const zone = route53.HostedZone.fromLookup(this, "Zone", { domainName: hostedZoneDomain })
      const recordName = domainName.replace(new RegExp(`\\.${hostedZoneDomain.replace(/\./g, "\\.")}$`), "")
      new route53.ARecord(this, "AliasRecord", {
        zone,
        recordName: recordName || undefined,
        target: route53.RecordTarget.fromAlias(new route53_targets.CloudFrontTarget(distribution)),
      })

      new cdk.CfnOutput(this, "WebSocketCustomUrl", {
        value: `wss://${domainName}`,
        description: "WebSocket URL via custom domain",
      })

      const executeApiEndpoint = `https://${originDomain}/prod`
      defaultFn.addEnvironment("RELAY_WEBSOCKET_EXECUTE_API_ENDPOINT", executeApiEndpoint)
    }
  }
}
