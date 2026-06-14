import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import { describe, expect, test } from "vite-plus/test";
import { ConstructTree, Match } from "../src/index.ts";

function newApp() {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");
  const bucket = new s3.Bucket(stack, "Bucket", {
    versioned: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_20_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => {};"),
    environment: { BUCKET_NAME: bucket.bucketName },
    memorySize: 256,
  });
  new cdk.CfnOutput(stack, "BucketNameOutput", {
    value: bucket.bucketName,
    description: "the bucket name",
  });
  new cdk.CfnParameter(stack, "Stage", { type: "String", default: "dev" });
  new cdk.CfnMapping(stack, "RegionMap", {
    mapping: { "us-east-1": { ami: "ami-123" } },
  });
  const condition = new cdk.CfnCondition(stack, "IsProd", {
    expression: cdk.Fn.conditionEquals("a", "a"),
  });
  return { stack, bucket, fn, condition };
}

describe("Template-compatible API (migration path)", () => {
  test("hasResourceProperties matches like assertions.Template", () => {
    const { stack } = newApp();
    const tree = ConstructTree.fromStack(stack);

    tree.hasResourceProperties("AWS::S3::Bucket", {
      VersioningConfiguration: { Status: "Enabled" },
    });
    tree.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "index.handler",
      MemorySize: 256,
    });
  });

  test("hasResourceProperties works with Match re-exported from this package", () => {
    const { stack } = newApp();
    const tree = ConstructTree.fromStack(stack);

    tree.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: { BUCKET_NAME: Match.anyValue() } },
      Runtime: Match.stringLikeRegexp("nodejs"),
    });
  });

  test("hasResourceProperties failure appends construct tree paths", () => {
    const { stack } = newApp();
    const tree = ConstructTree.fromStack(stack);

    expect(() =>
      tree.hasResourceProperties("AWS::S3::Bucket", {
        VersioningConfiguration: { Status: "Suspended" },
      }),
    ).toThrow(/TestStack\/Bucket\/Resource/);
  });

  test("hasResource checks beyond Properties", () => {
    const { stack } = newApp();
    const tree = ConstructTree.fromStack(stack);

    tree.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      Properties: { VersioningConfiguration: { Status: "Enabled" } },
    });
  });

  test("resourceCountIs and resourcePropertiesCountIs", () => {
    const { stack } = newApp();
    const tree = ConstructTree.fromStack(stack);

    tree.resourceCountIs("AWS::S3::Bucket", 1);
    tree.resourceCountIs("AWS::SQS::Queue", 0);
    tree.resourcePropertiesCountIs("AWS::Lambda::Function", { MemorySize: 256 }, 1);
    expect(() => tree.resourceCountIs("AWS::S3::Bucket", 2)).toThrow(/TestStack\/Bucket\/Resource/);
  });

  test("allResources / allResourcesProperties", () => {
    const { stack } = newApp();
    const tree = ConstructTree.fromStack(stack);

    tree.allResourcesProperties("AWS::S3::Bucket", {
      VersioningConfiguration: { Status: "Enabled" },
    });
    tree.allResources("AWS::S3::Bucket", { DeletionPolicy: "Retain" });
  });

  test("findResources returns the matching resource entries", () => {
    const { stack } = newApp();
    const tree = ConstructTree.fromStack(stack);

    const buckets = tree.findResources("AWS::S3::Bucket");
    expect(Object.keys(buckets)).toHaveLength(1);
    const [resource] = Object.values(buckets);
    expect(resource.Properties.VersioningConfiguration).toEqual({ Status: "Enabled" });
  });

  test("outputs, parameters, mappings, conditions", () => {
    const { stack } = newApp();
    const tree = ConstructTree.fromStack(stack);

    tree.hasOutput("BucketNameOutput", { Description: "the bucket name" });
    expect(Object.keys(tree.findOutputs("*"))).toContain("BucketNameOutput");

    tree.hasParameter("Stage", { Type: "String", Default: "dev" });
    expect(Object.keys(tree.findParameters("*"))).toContain("Stage");

    tree.hasMapping("RegionMap", { "us-east-1": { ami: "ami-123" } });
    expect(Object.keys(tree.findMappings("*"))).toContain("RegionMap");

    tree.hasCondition("IsProd", Match.anyValue());
    expect(Object.keys(tree.findConditions("*"))).toContain("IsProd");
  });

  test("templateMatches and toJSON", () => {
    const { stack } = newApp();
    const tree = ConstructTree.fromStack(stack);

    tree.templateMatches(
      Match.objectLike({
        Resources: Match.objectLike({}),
      }),
    );
    expect(tree.toJSON().Resources).toBeDefined();
  });

  test("compat API and typed API coexist on one tree", () => {
    const { stack } = newApp();
    const tree = ConstructTree.fromStack(stack);

    // migrated, template-shaped assertion
    tree.hasResourceProperties("AWS::S3::Bucket", {
      VersioningConfiguration: { Status: "Enabled" },
    });
    // new, intent-level assertion against the same index
    tree
      .findByType(s3.Bucket)
      .one()
      .expectProperty("bucketName", (n) => typeof n === "string");
  });
});
