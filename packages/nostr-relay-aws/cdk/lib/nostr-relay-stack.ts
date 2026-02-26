import * as cdk from "aws-cdk-lib"
import { Duration } from "aws-cdk-lib"
import { ApiMapping, DomainName, WebSocketApi, WebSocketStage } from "aws-cdk-lib/aws-apigatewayv2"
import { WebSocketLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations"
import * as acm from "aws-cdk-lib/aws-certificatemanager"
import { AttributeType, BillingMode, ProjectionType, Table } from "aws-cdk-lib/aws-dynamodb"
import { Runtime } from "aws-cdk-lib/aws-lambda"
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs"
import * as route53 from "aws-cdk-lib/aws-route53"
import * as route53_targets from "aws-cdk-lib/aws-route53-targets"
import type { Construct } from "constructs"

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

    const prodStage = new WebSocketStage(this, "ProdStage", {
      webSocketApi: wsApi,
      stageName: "prod",
      autoDeploy: true,
    })

    new cdk.CfnOutput(this, "WebSocketUrl", { value: wsApi.apiEndpoint + "/prod" })

    const domainName = this.node.tryGetContext("domainName") as string | undefined
    const certificateArn = this.node.tryGetContext("certificateArn") as string | undefined
    const hostedZoneDomain = this.node.tryGetContext("hostedZoneDomain") as string | undefined

    if (domainName && certificateArn && hostedZoneDomain) {
      const domain = new DomainName(this, "Domain", {
        domainName,
        certificate: acm.Certificate.fromCertificateArn(this, "Cert", certificateArn),
      })

      new ApiMapping(this, "Mapping", {
        api: wsApi,
        domainName: domain,
        stage: prodStage,
      })

      const zone = route53.HostedZone.fromLookup(this, "Zone", { domainName: hostedZoneDomain })
      const recordName = domainName.replace(new RegExp(`\\.${hostedZoneDomain.replace(/\./g, "\\.")}$`), "")
      new route53.ARecord(this, "AliasRecord", {
        zone,
        recordName: recordName || undefined,
        target: route53.RecordTarget.fromAlias(
          new route53_targets.ApiGatewayv2DomainProperties(domain.regionalDomainName, domain.regionalHostedZoneId),
        ),
      })

      new cdk.CfnOutput(this, "WebSocketCustomUrl", {
        value: `wss://${domainName}`,
        description: "WebSocket URL via custom domain",
      })

      const executeApiEndpoint = `https://${wsApi.apiId}.execute-api.${this.region}.amazonaws.com/prod`
      defaultFn.addEnvironment("RELAY_WEBSOCKET_EXECUTE_API_ENDPOINT", executeApiEndpoint)
    }
  }
}
