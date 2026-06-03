import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import { ConstructTree, expectGrant, expectResourcePolicy } from "../../src/index.ts";

// Type-level test: each erroring call must sit immediately after its
// `@ts-expect-error` directive (a directive only suppresses the next line).
// Subjects are extracted to variables so the error lands on a single line.

const stack = new cdk.Stack();
const tree = ConstructTree.fromStack(stack);

const bucketL1 = tree.findByType(s3.Bucket).one().defaultResource(s3.CfnBucket);

// @ts-expect-error 1) non-existent L1 property name
bucketL1.toMatchProps({ notARealProperty: "x" });

// @ts-expect-error 2) wrong nested property key
bucketL1.toMatchProps({ versioningConfiguration: { stattus: "Enabled" } });

const fnL1 = tree.findByType(lambda.Function).one().defaultResource(lambda.CfnFunction);

// @ts-expect-error 3) wrong value type (string for a number prop)
fnL1.toMatchProps({ memorySize: "big" });

const fnSubject = tree.findByType(lambda.Function).one();

// @ts-expect-error 4) non-existent L2 property name
fnSubject.expectProperty("nope", () => true);

const grant = expectGrant(tree).principal(fnSubject);

// @ts-expect-error 5) typo'd IAM action (not in the Service Reference)
grant.can("s3:GetObjekt");

// @ts-expect-error 6) wildcard scoped to an unknown service prefix
grant.can("notaservice:*");

const policy = expectResourcePolicy(tree).of(bucketL1.actual);

// @ts-expect-error 7) misspelled StatementCriteria key
policy.hasStatement({ efffect: "Allow" });

const metrics =
  bucketL1.collection<s3.CfnBucket.MetricsConfigurationProperty>("metricsConfigurations");

// @ts-expect-error 8) element prop name typo in a collection element matcher
metrics.first().toMatchProps({ prefex: "images/" });

// @ts-expect-error 9) wrong element field type in a collection predicate
metrics.where((m) => m.id === 123);

// @ts-expect-error 10) expectNoProperty on a non-existent authoring property name
bucketL1.expectNoProperty("notARealProperty");

// Correct usage must NOT error.
bucketL1.toMatchProps({ versioningConfiguration: { status: "Enabled" } });
expectGrant(tree).principal(fnSubject).can("s3:GetObject", "s3:*", "s3:Get*", "*");
expectResourcePolicy(tree)
  .of(bucketL1.actual)
  .allows({ service: "logs.amazonaws.com" })
  .to("s3:GetObject");
metrics.where((m) => m.id === "Images").expectCount(1);
