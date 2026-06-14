import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import { describe, expect, test } from "vite-plus/test";
import {
  ConstructTree,
  expectGrant,
  expectNoPlaintextSecret,
  expectNoPublicAccess,
  expectNoWildcard,
  expectPublicAccess,
} from "../src/index.ts";

function newFn(stack: cdk.Stack, id: string, env?: { [key: string]: string }) {
  return new lambda.Function(stack, id, {
    runtime: lambda.Runtime.NODEJS_20_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => {};"),
    environment: env,
  });
}

describe("expectGrant cannot (negative grant)", () => {
  function grantApp() {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");
    const bucket = new s3.Bucket(stack, "Bucket");
    const fn = newFn(stack, "Fn");
    bucket.grantRead(fn);
    return { stack, bucket, fn };
  }

  test("passes when the action is not granted", () => {
    const { stack, bucket, fn } = grantApp();
    const tree = ConstructTree.fromStack(stack);

    expectGrant(tree).principal(fn).cannot("s3:DeleteObject").on(bucket);
    expectGrant(tree).principal(fn).cannot("s3:PutObject").on(bucket);
  });

  test("fails when the action IS granted, naming the offending policy", () => {
    const { stack, bucket, fn } = grantApp();
    const tree = ConstructTree.fromStack(stack);

    expect(() => expectGrant(tree).principal(fn).cannot("s3:GetObject").on(bucket)).toThrow(
      /NOT to be granted \[s3:GetObject\][\s\S]*allowed by TestStack\//,
    );
  });

  test("a wildcard asserts absence of the whole family", () => {
    const { stack, bucket, fn } = grantApp();
    const tree = ConstructTree.fromStack(stack);

    // grantRead granted s3:GetObject* — so "no s3 access at all" must fail
    expect(() => expectGrant(tree).principal(fn).cannot("s3:*").on(bucket)).toThrow(
      /NOT to be granted/,
    );
  });

  test("sees grants from in-stack managed policies", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");
    const bucket = new s3.Bucket(stack, "Bucket");
    const role = new iam.Role(stack, "Role", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    role.addManagedPolicy(
      new iam.ManagedPolicy(stack, "Managed", {
        statements: [
          new iam.PolicyStatement({
            actions: ["s3:DeleteObject"],
            resources: [bucket.arnForObjects("*")],
          }),
        ],
      }),
    );
    const tree = ConstructTree.fromStack(stack);

    expect(() => expectGrant(tree).principal(role).cannot("s3:DeleteObject").on(bucket)).toThrow(
      /NOT to be granted/,
    );
    expectGrant(tree).principal(role).can("s3:DeleteObject").on(bucket);
  });

  test("mixing can() and cannot() is rejected", () => {
    const { stack, bucket, fn } = grantApp();
    const tree = ConstructTree.fromStack(stack);

    expect(() =>
      expectGrant(tree).principal(fn).can("s3:GetObject").cannot("s3:DeleteObject").on(bucket),
    ).toThrow(/must not be mixed/);
  });

  test("a principal without a role is a miswired test, not a vacuous pass", () => {
    const { stack, bucket } = grantApp();
    const tree = ConstructTree.fromStack(stack);

    expect(() => expectGrant(tree).principal(bucket).cannot("s3:GetObject").on(bucket)).toThrow(
      /could not find an IAM role/,
    );
  });
});

describe("expectNoWildcard", () => {
  test("passes on CDK grant output (partial wildcards are idiomatic)", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");
    const bucket = new s3.Bucket(stack, "Bucket");
    const fn = newFn(stack, "Fn");
    bucket.grantRead(fn); // emits s3:GetObject*, s3:GetBucket*, s3:List* — fine
    const tree = ConstructTree.fromStack(stack);

    expectNoWildcard(tree).inPoliciesOf(fn);
  });

  test("flags a whole-service action wildcard", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");
    const bucket = new s3.Bucket(stack, "Bucket");
    const fn = newFn(stack, "Fn");
    fn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["s3:*"], resources: [bucket.bucketArn] }),
    );
    const tree = ConstructTree.fromStack(stack);

    expect(() => expectNoWildcard(tree).inPoliciesOf(fn)).toThrow(/Action "s3:\*"/);
  });

  test("flags Resource '*' and accepts an except() exemption", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");
    const fn = newFn(stack, "Fn");
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["xray:PutTraceSegments", "xray:PutTelemetryRecords"],
        resources: ["*"],
      }),
    );
    const tree = ConstructTree.fromStack(stack);

    expect(() => expectNoWildcard(tree).inPoliciesOf(fn)).toThrow(/Resource "\*"/);
    expectNoWildcard(tree).except("xray:*").inPoliciesOf(fn);
  });

  test("except() does not exempt a global Action '*'", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");
    const fn = newFn(stack, "Fn");
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["*"], resources: ["*"] }));
    const tree = ConstructTree.fromStack(stack);

    expect(() => expectNoWildcard(tree).except("xray:*").inPoliciesOf(fn)).toThrow(/Action "\*"/);
  });
});

describe("expectNoPublicAccess / expectPublicAccess", () => {
  test("flags a security group open to the world", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");
    const vpc = new ec2.Vpc(stack, "Vpc", { natGateways: 0 });
    const open = new ec2.SecurityGroup(stack, "Open", { vpc });
    open.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80));
    const closed = new ec2.SecurityGroup(stack, "Closed", { vpc });
    closed.addIngressRule(open, ec2.Port.tcp(443));
    const tree = ConstructTree.fromStack(stack);

    expect(() => expectNoPublicAccess(tree).of(open)).toThrow(
      /ingress from 0\.0\.0\.0\/0 on port 80/,
    );
    expectNoPublicAccess(tree).of(closed);
    expectPublicAccess(tree).of(open);
  });

  test("flags an internet-facing load balancer", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");
    const vpc = new ec2.Vpc(stack, "Vpc", { natGateways: 0 });
    const alb = new elbv2.ApplicationLoadBalancer(stack, "Alb", { vpc, internetFacing: true });
    const internal = new elbv2.ApplicationLoadBalancer(stack, "Internal", { vpc });
    const tree = ConstructTree.fromStack(stack);

    expect(() => expectNoPublicAccess(tree).of(alb)).toThrow(/internet-facing load balancer/);
    expectPublicAccess(tree).of(alb);
    // the internal ALB's SG is what anyIpv4 ingress would land on — none here
    expect(() => expectPublicAccess(tree).of(internal)).toThrow(/to be publicly accessible/);
  });

  test("flags an unconditioned star-principal bucket policy, not enforceSSL's Deny", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");
    const publicBucket = new s3.Bucket(stack, "PublicBucket");
    publicBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [publicBucket.arnForObjects("*")],
        principals: [new iam.AnyPrincipal()],
      }),
    );
    const sslBucket = new s3.Bucket(stack, "SslBucket", { enforceSSL: true });
    const tree = ConstructTree.fromStack(stack);

    expect(() => expectNoPublicAccess(tree).of(publicBucket)).toThrow(
      /allows Principal "\*" without conditions/,
    );
    // enforceSSL adds Deny + Principal "*" — protective, must NOT be flagged
    expectNoPublicAccess(tree).of(sslBucket);
  });

  test("flags a public Lambda function URL and a public RDS instance", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");
    const fn = newFn(stack, "Fn");
    fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
    const vpc = new ec2.Vpc(stack, "Vpc", { natGateways: 0 });
    const db = new rds.DatabaseInstance(stack, "Db", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      vpc,
      publiclyAccessible: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });
    const tree = ConstructTree.fromStack(stack);

    expect(() => expectNoPublicAccess(tree).of(fn)).toThrow(/function URL with AuthType NONE/);
    expect(() => expectNoPublicAccess(tree).of(db)).toThrow(/publicly accessible database/);
  });
});

describe("expectNoPlaintextSecret", () => {
  test("passes for tokens and ordinary configuration values", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");
    const bucket = new s3.Bucket(stack, "Bucket");
    const fn = newFn(stack, "Fn", {
      BUCKET_NAME: bucket.bucketName, // token → intrinsic, safe
      LOG_LEVEL: "debug",
      USE_TOKEN_AUTH: "true", // secret-ish name but trivial flag value
    });
    const tree = ConstructTree.fromStack(stack);

    expectNoPlaintextSecret(tree).of(fn);
  });

  test("flags a literal value under a secret-like name, without printing it", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");
    const fn = newFn(stack, "Fn", { DB_PASSWORD: "hunter2hunter2" });
    const tree = ConstructTree.fromStack(stack);

    let message = "";
    try {
      expectNoPlaintextSecret(tree).of(fn);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/'DB_PASSWORD' is named like a secret/);
    expect(message).not.toContain("hunter2hunter2");
  });

  test("flags a known credential format regardless of the variable name", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");
    const fn = newFn(stack, "Fn", { UPLOADER: "AKIAIOSFODNN7EXAMPLE" });
    const tree = ConstructTree.fromStack(stack);

    expect(() => expectNoPlaintextSecret(tree).of(fn)).toThrow(/known credential format/);
  });

  test("dynamic references to Secrets Manager are safe", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");
    const fn = newFn(stack, "Fn", {
      DB_PASSWORD: cdk.SecretValue.secretsManager("prod/db").unsafeUnwrap(),
    });
    const tree = ConstructTree.fromStack(stack);

    expectNoPlaintextSecret(tree).of(fn);
  });

  test("allowingKeys() exempts a named false positive", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");
    const fn = newFn(stack, "Fn", { API_KEY_PARAM_NAME: "/prod/payment/api-key" });
    const tree = ConstructTree.fromStack(stack);

    expect(() => expectNoPlaintextSecret(tree).of(fn)).toThrow(/'API_KEY_PARAM_NAME'/);
    expectNoPlaintextSecret(tree).allowingKeys("API_KEY_PARAM_NAME").of(fn);
  });
});
