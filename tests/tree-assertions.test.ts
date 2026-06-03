import * as cdk from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import { Match } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sources from "aws-cdk-lib/aws-lambda-event-sources";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { describe, expect, test } from "vite-plus/test";
import {
  ConstructTree,
  expectBucketPolicy,
  expectConnection,
  expectEncryption,
  expectEventSource,
  expectFlow,
  expectGrant,
  expectNoEventSource,
  expectNoRoute,
  expectNoSchedule,
  expectResourcePolicy,
  expectRoute,
  expectSchedule,
  type L1Subject,
} from "../src/index.ts";

function newApp() {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");
  const bucket = new s3.Bucket(stack, "Bucket", { versioned: true });
  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_20_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => {};"),
    environment: { BUCKET_NAME: bucket.bucketName },
    timeout: cdk.Duration.seconds(30),
    memorySize: 256,
  });
  bucket.grantRead(fn);
  return { stack, bucket, fn };
}

describe("Tree Query", () => {
  test("findByType counts L2 constructs", () => {
    const { stack } = newApp();
    const tree = ConstructTree.fromStack(stack);

    tree.findByType(s3.Bucket).expectCount(1);
    tree.findByType(lambda.Function).expectCount(1);
    tree.findByType(s3.Bucket).toExist();
    tree.findByType(iam.User).toBeEmpty();
  });

  test("where narrows by a typed predicate", () => {
    const { stack } = newApp();
    const tree = ConstructTree.fromStack(stack);

    tree
      .findByType(s3.Bucket)
      .where((b) => b.node.id === "Bucket")
      .expectCount(1);
  });

  test("one() fails when the count is not exactly one", () => {
    const { stack } = newApp();
    const tree = ConstructTree.fromStack(stack);
    expect(() => tree.findByType(iam.User).one()).toThrow(/Expected exactly one/);
  });
});

describe("L2 subject", () => {
  test("expectProperty checks a typed public property", () => {
    const { stack } = newApp();
    const tree = ConstructTree.fromStack(stack);

    tree
      .findByType(lambda.Function)
      .one()
      .expectProperty("runtime", (r) => r === lambda.Runtime.NODEJS_20_X);
  });

  test("expectProperty fails with a helpful message", () => {
    const { stack } = newApp();
    const tree = ConstructTree.fromStack(stack);

    expect(() =>
      tree
        .findByType(lambda.Function)
        .one()
        .expectProperty("runtime", (r) => r === lambda.Runtime.PYTHON_3_12),
    ).toThrow(/Expected property 'runtime'/);
  });

  test("satisfies hands back the fully-typed instance", () => {
    const { stack } = newApp();
    const tree = ConstructTree.fromStack(stack);

    tree
      .findByType(lambda.Function)
      .one()
      .satisfies((f) => {
        expect(f.isBoundToVpc).toBe(false);
      });
  });
});

describe("L1 subject", () => {
  test("toMatchProps matches resolved CFN properties (type-safe)", () => {
    const { stack } = newApp();
    const tree = ConstructTree.fromStack(stack);

    tree
      .findByType(s3.Bucket)
      .one()
      .defaultResource(s3.CfnBucket)
      .toMatchProps({
        versioningConfiguration: { status: "Enabled" },
      });

    tree
      .findByType(lambda.Function)
      .one()
      .defaultResource(lambda.CfnFunction)
      .toMatchProps({
        timeout: 30,
        memorySize: 256,
        runtime: "nodejs20.x",
        environment: { variables: { BUCKET_NAME: Match.anyValue() } },
      });
  });

  test("toMatchProps fails with a rendered mismatch", () => {
    const { stack } = newApp();
    const tree = ConstructTree.fromStack(stack);

    expect(() =>
      tree
        .findByType(s3.Bucket)
        .one()
        .defaultResource(s3.CfnBucket)
        .toMatchProps({ versioningConfiguration: { status: "Suspended" } }),
    ).toThrow(/did not|to match props|Suspended/);
  });

  test("defaultResource type mismatch is reported", () => {
    const { stack } = newApp();
    const tree = ConstructTree.fromStack(stack);

    expect(() => tree.findByType(s3.Bucket).one().defaultResource(lambda.CfnFunction)).toThrow(
      /is not a CfnFunction/,
    );
  });
});

describe("Wiring", () => {
  test("references detects a Ref/GetAtt link", () => {
    const { stack, bucket, fn } = newApp();
    const tree = ConstructTree.fromStack(stack);

    const fnSubject = tree.findByPath(fn.node.path).one();
    const bucketSubject = tree.findByPath(bucket.node.path).one();

    // The Lambda env var references the bucket name.
    fnSubject.references(bucketSubject);
    bucketSubject.referencedBy(fnSubject);
  });

  test("references fails when there is no link", () => {
    const { stack } = newApp();
    const lonely = new s3.Bucket(stack, "Lonely");
    const tree = ConstructTree.fromStack(stack);

    const lonelySubject = tree.findByPath(lonely.node.path).one();
    const fnSubject = tree.findByType(lambda.Function).one();
    expect(() => fnSubject.references(lonelySubject)).toThrow(/to reference/);
  });

  test("expectGrant verifies an IAM grant by following the role policies", () => {
    const { stack, bucket, fn } = newApp();
    const tree = ConstructTree.fromStack(stack);

    expectGrant(tree).principal(fn).can("s3:GetObject").on(bucket);
    expectGrant(tree).principal(fn).can("s3:GetObject*").on(bucket);
  });

  test("expectGrant fails for an action that was not granted", () => {
    const { stack, bucket, fn } = newApp();
    const tree = ConstructTree.fromStack(stack);

    expect(() => expectGrant(tree).principal(fn).can("s3:DeleteObject").on(bucket)).toThrow(
      /no matching Allow statement/,
    );
  });
});

describe("Wiring — security group connections", () => {
  function networked() {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "Net");
    const vpc = new ec2.Vpc(stack, "Vpc");
    const a = new ec2.SecurityGroup(stack, "SgA", { vpc });
    const b = new ec2.SecurityGroup(stack, "SgB", { vpc });
    a.connections.allowTo(b, ec2.Port.tcp(443), "a to b");
    return { stack, a, b };
  }

  test("expectConnection verifies an ingress rule from source to target", () => {
    const { stack, a, b } = networked();
    const tree = ConstructTree.fromStack(stack);

    expectConnection(tree).from(a).to(b).onPort(443);
  });

  test("expectConnection fails on the wrong port", () => {
    const { stack, a, b } = networked();
    const tree = ConstructTree.fromStack(stack);

    expect(() => expectConnection(tree).from(a).to(b).onPort(80)).toThrow(/connect to/);
  });

  test("expectConnection fails on the wrong direction", () => {
    const { stack, a, b } = networked();
    const tree = ConstructTree.fromStack(stack);

    // The rule allows A -> B, not B -> A.
    expect(() => expectConnection(tree).from(b).to(a).onPort(443)).toThrow(/connect to/);
  });
});

describe("Wiring — encryption", () => {
  function encrypted() {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "Enc");
    const key = new kms.Key(stack, "Key");
    const bucket = new s3.Bucket(stack, "Bucket", { encryptionKey: key });
    const queue = new sqs.Queue(stack, "Queue", { encryptionMasterKey: key });
    const plain = new s3.Bucket(stack, "Plain");
    return { stack, key, bucket, queue, plain };
  }

  test("expectEncryption verifies the key wiring across services", () => {
    const { stack, key, bucket, queue } = encrypted();
    const tree = ConstructTree.fromStack(stack);

    expectEncryption(tree).of(bucket).withKey(key);
    expectEncryption(tree).of(queue).withKey(key);
  });

  test("expectEncryption fails for an unencrypted resource", () => {
    const { stack, key, plain } = encrypted();
    const tree = ConstructTree.fromStack(stack);

    expect(() => expectEncryption(tree).of(plain).withKey(key)).toThrow(/encrypted with/);
  });
});

describe("Wiring — resource policy", () => {
  function withPolicies() {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "Rp");
    const bucket = new s3.Bucket(stack, "Bucket", { enforceSSL: true, minimumTLSVersion: 1.2 });
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        principals: [new iam.ServicePrincipal("logs.amazonaws.com")],
        resources: [bucket.arnForObjects("*")],
      }),
    );
    const key = new kms.Key(stack, "Key");
    key.grantDecrypt(new iam.ServicePrincipal("logs.amazonaws.com"));
    const plain = new s3.Bucket(stack, "Plain");
    return { stack, bucket, key, plain };
  }

  test("expectBucketPolicy reads enforceSSL / minimumTLSVersion as intent", () => {
    const { stack, bucket } = withPolicies();
    const tree = ConstructTree.fromStack(stack);

    expectBucketPolicy(tree).of(bucket).deniesInsecureTransport().deniesTlsBelow(1.2);
  });

  test("expectResourcePolicy matches a service principal grant on a bucket policy", () => {
    const { stack, bucket } = withPolicies();
    const tree = ConstructTree.fromStack(stack);

    expectResourcePolicy(tree)
      .of(bucket)
      .allows({ service: "logs.amazonaws.com" })
      .to("s3:GetObject");
  });

  test("expectResourcePolicy reads an inline KMS key policy", () => {
    const { stack, key } = withPolicies();
    const tree = ConstructTree.fromStack(stack);

    expectResourcePolicy(tree).of(key).allows({ service: "logs.amazonaws.com" }).to("kms:Decrypt");
  });

  test("hasNoStatement guarantees absence", () => {
    const { stack, bucket } = withPolicies();
    const tree = ConstructTree.fromStack(stack);

    expectResourcePolicy(tree)
      .of(bucket)
      .hasNoStatement({ effect: "Allow", principal: { service: "evil.amazonaws.com" } });
  });

  test("expectBucketPolicy fails when no policy is attached", () => {
    const { stack, plain } = withPolicies();
    const tree = ConstructTree.fromStack(stack);

    expect(() => expectBucketPolicy(tree).of(plain).deniesInsecureTransport()).toThrow(
      /resource policy of .* to contain/,
    );
  });
});

describe("L1 — removal policy", () => {
  function removalPolicies() {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "Rm");
    const retain = new s3.Bucket(stack, "Retain", { removalPolicy: cdk.RemovalPolicy.RETAIN });
    const destroy = new s3.Bucket(stack, "Destroy", { removalPolicy: cdk.RemovalPolicy.DESTROY });
    return { stack, retain, destroy };
  }

  test("hasRemovalPolicy maps RemovalPolicy to DeletionPolicy", () => {
    const { stack } = removalPolicies();
    const tree = ConstructTree.fromStack(stack);

    tree
      .findByType(s3.Bucket)
      .where((b) => b.node.id === "Retain")
      .one()
      .hasRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    tree
      .findByType(s3.Bucket)
      .where((b) => b.node.id === "Destroy")
      .one()
      .defaultResource(s3.CfnBucket)
      .hasDeletionPolicy("Delete")
      .hasRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  });

  test("hasRemovalPolicy fails on a mismatch", () => {
    const { stack } = removalPolicies();
    const tree = ConstructTree.fromStack(stack);

    const destroy = tree
      .findByType(s3.Bucket)
      .where((b) => b.node.id === "Destroy")
      .one();
    expect(() => destroy.hasRemovalPolicy(cdk.RemovalPolicy.RETAIN)).toThrow(
      /DeletionPolicy 'Retain'/,
    );
  });
});

describe("L1 — collection", () => {
  function withCollections() {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "Col");
    const bucket = new s3.Bucket(stack, "Bucket", {
      metrics: [{ id: "EntireBucket" }, { id: "Images", prefix: "images/" }],
      lifecycleRules: [
        { id: "expire", expiration: cdk.Duration.days(365) },
        {
          id: "archive",
          transitions: [
            { storageClass: s3.StorageClass.GLACIER, transitionAfter: cdk.Duration.days(30) },
          ],
        },
      ],
    });
    return { stack, bucket };
  }

  test("collection over a top-level array property (metrics), id-based not index-based", () => {
    const { stack } = withCollections();
    const tree = ConstructTree.fromStack(stack);
    const l1 = tree.findByType(s3.Bucket).one().defaultResource(s3.CfnBucket);

    l1.collection<s3.CfnBucket.MetricsConfigurationProperty>("metricsConfigurations").expectCount(
      2,
    );
    l1.collection<s3.CfnBucket.MetricsConfigurationProperty>("metricsConfigurations")
      .where((m) => m.id === "Images")
      .one()
      .toMatchProps({ prefix: "images/" });
  });

  test("collection over a nested array property (lifecycle rules) via accessor", () => {
    const { stack } = withCollections();
    const tree = ConstructTree.fromStack(stack);
    const l1 = tree.findByType(s3.Bucket).one().defaultResource(s3.CfnBucket);

    l1.collection<s3.CfnBucket.RuleProperty>(["lifecycleConfiguration", "rules"])
      .where((r) => r.id === "expire")
      .one()
      .toMatchProps({ expirationInDays: 365 });
  });

  test("collection where() narrowing makes count assertions exact", () => {
    const { stack } = withCollections();
    const tree = ConstructTree.fromStack(stack);
    const l1 = tree.findByType(s3.Bucket).one().defaultResource(s3.CfnBucket);

    expect(() =>
      l1
        .collection<s3.CfnBucket.MetricsConfigurationProperty>("metricsConfigurations")
        .where((m) => m.id === "Nope")
        .expectCount(1),
    ).toThrow(/Expected 1 element/);
  });
});

describe("L1 — property presence & overrides", () => {
  function withOverrides() {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "Ov");

    const overridden = new s3.Bucket(stack, "Overridden");
    const ocfn = overridden.node.defaultChild as s3.CfnBucket;
    ocfn.addPropertyOverride("BucketName", "overridden-name");
    ocfn.addPropertyOverride("VersioningConfiguration.Status", "Enabled");

    const deleted = new s3.Bucket(stack, "Deleted", { versioned: true });
    (deleted.node.defaultChild as s3.CfnBucket).addPropertyDeletionOverride(
      "VersioningConfiguration",
    );

    new s3.Bucket(stack, "Plain");
    return { stack };
  }

  function l1(stack: cdk.Stack, id: string): L1Subject<s3.CfnBucket, s3.CfnBucketProps> {
    return ConstructTree.fromStack(stack)
      .findByType(s3.Bucket)
      .where((b) => b.node.id === id)
      .one()
      .defaultResource(s3.CfnBucket);
  }

  test("expectNoProperty passes when an authoring prop is unset, fails when set", () => {
    const { stack } = withOverrides();

    l1(stack, "Plain").expectNoProperty("websiteConfiguration");
    expect(() => l1(stack, "Deleted").expectNoProperty("versioningConfiguration")).toThrow(
      /not to set property 'versioningConfiguration'/,
    );
  });

  test("expectCfnPath sees addPropertyOverride that toMatchProps cannot", () => {
    const { stack } = withOverrides();

    l1(stack, "Overridden").expectCfnPath("BucketName", "overridden-name");
    l1(stack, "Overridden").expectCfnPath(["VersioningConfiguration", "Status"], "Enabled");
    l1(stack, "Overridden").expectCfnPath("BucketName", Match.anyValue());

    // toMatchProps reads the instance field, which the raw override never touched.
    expect(() => l1(stack, "Overridden").toMatchProps({ bucketName: "overridden-name" })).toThrow(
      /to match props/,
    );
  });

  test("expectCfnPath fails on a wrong value", () => {
    const { stack } = withOverrides();

    expect(() => l1(stack, "Overridden").expectCfnPath("BucketName", "other")).toThrow(/to match/);
  });

  test("expectCfnPathAbsent sees addPropertyDeletionOverride, and fails when present", () => {
    const { stack } = withOverrides();

    l1(stack, "Deleted").expectCfnPathAbsent("VersioningConfiguration");
    l1(stack, "Plain").expectCfnPathAbsent("BucketName");
    expect(() => l1(stack, "Overridden").expectCfnPathAbsent("BucketName")).toThrow(
      /not to have a rendered property/,
    );
  });
});

describe("Wiring — event source", () => {
  function withEventSource() {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "Es");
    const queue = new sqs.Queue(stack, "Queue");
    const other = new sqs.Queue(stack, "Other");
    const fn = new lambda.Function(stack, "Fn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "i.h",
      code: lambda.Code.fromInline("exports.h=async()=>{}"),
    });
    fn.addEventSource(new sources.SqsEventSource(queue));
    return { stack, queue, other, fn };
  }

  test("expectEventSource verifies the Lambda consumes the source", () => {
    const { stack, queue, fn } = withEventSource();
    const tree = ConstructTree.fromStack(stack);

    expectEventSource(tree).of(fn).from(queue);
  });

  test("expectEventSource fails for an unrelated source", () => {
    const { stack, other, fn } = withEventSource();
    const tree = ConstructTree.fromStack(stack);

    expect(() => expectEventSource(tree).of(fn).from(other)).toThrow(/to consume events from/);
  });

  test("expectNoEventSource guarantees absence", () => {
    const { stack, other, fn } = withEventSource();
    const tree = ConstructTree.fromStack(stack);

    expectNoEventSource(tree).of(fn).from(other);
    expect(() => expectNoEventSource(tree).of(fn).from(withEventSource().queue)).toThrow();
  });
});

describe("Wiring — schedule", () => {
  function withSchedule() {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "Sched");
    const fn = new lambda.Function(stack, "Fn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "i.h",
      code: lambda.Code.fromInline("exports.h=async()=>{}"),
    });
    const cron = new events.Rule(stack, "Cron", {
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
    });
    cron.addTarget(new targets.LambdaFunction(fn));

    // A non-scheduled (event-pattern) rule targeting the same function.
    const onEvent = new events.Rule(stack, "OnEvent", {
      eventPattern: { source: ["my.app"] },
    });
    onEvent.addTarget(new targets.LambdaFunction(fn));
    return { stack, cron, onEvent, fn };
  }

  test("expectSchedule verifies a scheduled rule triggers the target", () => {
    const { stack, cron, fn } = withSchedule();
    const tree = ConstructTree.fromStack(stack);

    expectSchedule(tree).rule(cron).triggers(fn);
    expectSchedule(tree).rule(cron).triggers(fn).onSchedule("rate(1 hour)");
  });

  test("expectSchedule fails on a wrong schedule expression", () => {
    const { stack, cron, fn } = withSchedule();
    const tree = ConstructTree.fromStack(stack);

    expect(() =>
      expectSchedule(tree).rule(cron).triggers(fn).onSchedule("rate(5 minutes)"),
    ).toThrow(/to trigger/);
  });

  test("expectSchedule ignores event-pattern (non-scheduled) rules", () => {
    const { stack, onEvent, fn } = withSchedule();
    const tree = ConstructTree.fromStack(stack);

    expectNoSchedule(tree).rule(onEvent).triggers(fn);
    expect(() => expectSchedule(tree).rule(onEvent).triggers(fn)).toThrow(/no scheduled rule/);
  });
});

describe("Wiring — API route", () => {
  function withApi() {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "Api");
    const fn = new lambda.Function(stack, "Fn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "i.h",
      code: lambda.Code.fromInline("exports.h=async()=>{}"),
    });
    const other = new lambda.Function(stack, "Other", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "i.h",
      code: lambda.Code.fromInline("exports.h=async()=>{}"),
    });
    const api = new apigw.RestApi(stack, "Api");
    const integ = new apigw.LambdaIntegration(fn);
    api.root.addMethod("GET", integ); // "/"
    const users = api.root.addResource("users");
    users.addMethod("GET", integ); // "/users"
    users.addResource("{id}").addMethod("GET", integ); // "/users/{id}"
    return { stack, api, fn, other };
  }

  test("expectRoute reconstructs the path and matches the handler", () => {
    const { stack, api, fn } = withApi();
    const tree = ConstructTree.fromStack(stack);

    expectRoute(tree).api(api).method("GET", "/").to(fn);
    expectRoute(tree).api(api).method("GET", "/users").to(fn);
    expectRoute(tree).api(api).method("GET", "/users/{id}").to(fn);
    expectRoute(tree).api(api).method("get", "users").to(fn); // case + leading-slash insensitive
  });

  test("expectRoute fails for an unrouted method, path, or handler", () => {
    const { stack, api, fn, other } = withApi();
    const tree = ConstructTree.fromStack(stack);

    expect(() => expectRoute(tree).api(api).method("DELETE", "/users").to(fn)).toThrow(/to route/);
    expect(() => expectRoute(tree).api(api).method("GET", "/missing").to(fn)).toThrow(/to route/);
    expect(() => expectRoute(tree).api(api).method("GET", "/users").to(other)).toThrow(/to route/);
  });

  test("expectNoRoute guarantees absence", () => {
    const { stack, api, fn, other } = withApi();
    const tree = ConstructTree.fromStack(stack);

    expectNoRoute(tree).api(api).method("GET", "/users").to(other);
    expect(() => expectNoRoute(tree).api(api).method("GET", "/users").to(fn)).toThrow();
  });
});

describe("Behavior — building-block flow", () => {
  function withFlow() {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "Flow");
    const mk = (id: string) =>
      new lambda.Function(stack, id, {
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: "i.h",
        code: lambda.Code.fromInline("exports.h=async()=>{}"),
      });
    const fn = mk("Fn");
    const worker = mk("Worker");
    const table = new dynamodb.Table(stack, "Table", {
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
    });
    const queue = new sqs.Queue(stack, "Queue");
    const topic = new sns.Topic(stack, "Topic");
    const bucket = new s3.Bucket(stack, "Bucket");

    // fn: API-ish handler that reads the table and fans out to a queue.
    table.grantReadData(fn);
    queue.grantSendMessages(fn);
    // worker: consumes and writes to the table + publishes to a topic + reads bucket.
    table.grantWriteData(worker);
    topic.grantPublish(worker);
    bucket.grantRead(worker);
    return { stack, fn, worker, table, queue, topic, bucket };
  }

  test("expectFlow reads as one sentence across building blocks", () => {
    const { stack, fn, table, queue } = withFlow();
    const tree = ConstructTree.fromStack(stack);

    expectFlow(tree).from(fn).reads(table).sendsTo(queue);
  });

  test("expectFlow carries the subject and switches with andThen()", () => {
    const { stack, fn, worker, table, queue, topic, bucket } = withFlow();
    const tree = ConstructTree.fromStack(stack);

    expectFlow(tree)
      .from(fn)
      .reads(table)
      .sendsTo(queue)
      .andThen(worker)
      .writes(table)
      .publishesTo(topic)
      .reads(bucket);
  });

  test("expectFlow fails on a missing edge, naming the broken step", () => {
    const { stack, fn, table } = withFlow();
    const tree = ConstructTree.fromStack(stack);

    // fn only has read on the table, not write.
    expect(() => expectFlow(tree).from(fn).writes(table)).toThrow(
      /Fn writes .*Table.* does not hold/,
    );
  });

  test("expectFlow rejects an unsupported resource type with guidance", () => {
    const { stack, fn } = withFlow();
    const tree = ConstructTree.fromStack(stack);
    const vpc = new ec2.Vpc(stack, "Vpc");

    expect(() => expectFlow(tree).from(fn).reads(vpc)).toThrow(/drop to expectGrant/);
  });
});
