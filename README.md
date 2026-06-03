# cdk-tree-assertions

> **Status: experimental.** TypeScript-only — intentionally relies on generics
> and mapped types and is **not** compiled through jsii.

**Intent-level, reviewable assertions for the AWS CDK Construct tree** (with
type safety as the enabling mechanism).

In a world where tests are increasingly **written by AI**, the bottleneck moves
from _writing_ to _reviewing_. The built-in `aws-cdk-lib/assertions` library
asserts against the **synthesized CloudFormation template** — magic strings
(`'AWS::S3::Bucket'`), untyped `PascalCase` blobs, and hand-traced IAM/security
group JSON. That is hard for a human to review for _intent_.

This library lets you state the intent directly:

```ts
expectGrant(tree).principal(fn).can("s3:GetObject").on(bucket);
expectConnection(tree).from(loadBalancer).to(service).onPort(443);
expectEncryption(tree).of(bucket).withKey(key);
```

A reviewer reads those as sentences. Underneath, everything is checked at
compile time (typed construct navigation, typed `CfnXxxProps`) and against the
resolved template — so the readable surface is also a precise one.

## Motivation: the right altitude for application IaC

`aws-cdk-lib/assertions` asserts at the **CloudFormation level**. That is exactly
the right altitude when you are **authoring a Construct Library**: there, the
CloudFormation output _is_ your contract, so pinning the exact `PascalCase`
properties, resource counts, and even whole-template snapshots is precisely what
you want to verify.

But most people are not writing Construct Libraries — they are writing
**application IaC**: composing L2/L3 constructs into a stack for a service. At
that altitude, CloudFormation-level assertions are **too low-level**. You authored
`bucket.grantRead(fn)` and `new lambda.Function(this, ..., { timeout })`, yet the
test makes you re-derive the resulting IAM `PolicyDocument`, hand-trace
`Fn::GetAtt`/`Fn::Join`, hardcode generated logical ids, and restate camelCase
props as `PascalCase` JSON. The test ends up a brittle transcription of the
synthesized template rather than a statement of what the stack is _supposed to
do_ — and it breaks on refactors that change nothing observable.

**This library exists to close that gap.** It lets application-IaC authors assert
at the altitude they actually worked at — typed constructs, L2 public properties,
`CfnXxxProps`, and intent-level wiring (`grant` / `connection` / `encryption` /
resource policy) — while still resolving down to the real template underneath. It
is a complement to `aws-cdk-lib/assertions`, not a replacement: drop down to
CloudFormation-level matching (or snapshots) where that is genuinely the contract,
and stay at intent level for everything else.

### Fragile under refactoring

CloudFormation-level assertions are also **brittle when you refactor**, even when
the deployed result is identical:

- **Logical ids are derived from the construct path.** Renaming a construct,
  moving it under a different scope, or extracting a group of constructs into an
  L3 construct changes the generated logical ids (e.g. `MyBucketF68F3FF0`). Any
  test that hardcodes them — directly, or inside a `Ref` / `Fn::GetAtt` /
  `DependsOn` — breaks, despite zero change to the actual infrastructure.
- **Snapshot tests churn.** A pure refactor produces a large template diff (ids,
  reordering), so the snapshot must be regenerated and re-reviewed — exactly when
  the diff carries no real signal.
- **Defaults and intrinsics shift.** Bumping the CDK version, or a small change
  upstream, re-renders `Fn::Join` ARNs and default property values that were
  pinned by hand.

Because this library matches on **typed construct references** (resolved through
the index) and **intent** rather than on logical ids or template JSON, a refactor
that preserves behavior keeps the tests green. You pass `bucket` and `fn`, not
`"MyBucketF68F3FF0"`, so renaming or restructuring the tree does not touch the
assertions.

## Install

```sh
npm install -D cdk-tree-assertions
# peers: aws-cdk-lib (^2) and constructs (^10)
```

## Usage

```ts
import { ConstructTree, expectGrant } from "cdk-tree-assertions";
import { Match } from "aws-cdk-lib/assertions";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as lambda from "aws-cdk-lib/aws-lambda";

const tree = ConstructTree.fromStack(stack);

// ── Tree query (no magic strings) ─────────────────────────
tree.findByType(lambda.Function).expectCount(1);

const fn = tree.findByType(lambda.Function).one();
const bucket = tree.findByType(s3.Bucket).one();

// ── L2 public API (typed property name + value) ───────────
fn.expectProperty("runtime", (r) => r === lambda.Runtime.NODEJS_20_X);

// ── L1 props (typed CfnXxxProps, token-resolved) ──────────
fn.defaultResource(lambda.CfnFunction).toMatchProps({
  timeout: 30,
  memorySize: 256,
  environment: { variables: { BUCKET_NAME: Match.anyValue() } },
});

// ── Wiring (dependency / reference / grant) ───────────────
fn.references(bucket);
expectGrant(tree).principal(fn).can("s3:GetObject").on(bucket);

// ── Escape hatch (the real, fully-typed instance) ─────────
fn.satisfies((f) => expect(f.isBoundToVpc).toBe(false));
```

## Concepts

`ConstructTree.fromStack(stack)` synthesizes the stack once (reusing the
`assertions` resolution path) and builds a **ConstructIndex** — a bidirectional
map between typed construct instances, CloudFormation logical ids, and resolved
properties. Every assertion below is backed by that index.

| Layer      | Type                                        | Highlights                                                                       |
| ---------- | ------------------------------------------- | -------------------------------------------------------------------------------- |
| Tree query | `ConstructQuery<T>`                         | `findByType` / `where` / `expectCount` / `one`                                   |
| Subject    | `ConstructSubject<T>`                       | `satisfies` / `expectProperty` / `defaultResource` / `dependsOn` / `references`  |
| L1 props   | `L1Subject<C, P>`                           | `toMatchProps` (typed against `CfnXxxProps`)                                     |
| Wiring     | `expectGrant`                               | `.principal().can().on()` — IAM grant                                            |
| Wiring     | `expectConnection`                          | `.from().to().onPort()` — security group reachability                            |
| Wiring     | `expectEncryption`                          | `.of().withKey()` — KMS key wiring                                               |
| Wiring     | `expectResourcePolicy`/`expectBucketPolicy` | `.of().allows()/.denies()`, `deniesInsecureTransport()` — resource-side policy   |
| Behavior   | `expectEventSource`                         | `.of(fn).from(source)` — Lambda event-source mapping                             |
| Behavior   | `expectSchedule`                            | `.rule(r).triggers(target).onSchedule(expr)` — scheduled EventBridge rule        |
| Behavior   | `expectRoute`                               | `.api(api).method("GET", "/users").to(fn)` — REST API Gateway route → handler    |
| Behavior   | `expectFlow`                                | `.from(fn).reads(table).sendsTo(queue).andThen(worker)...` — building-block flow |

Each wiring/behavior assertion is a thin, well-named reading of the resolved
template backed by the index — adding a new one (e.g. SNS→SQS subscription,
log-group destinations) is a small, uniform amount of code. The behavior
assertions push the surface toward _what the stack does_ (events, schedules,
routes) rather than what CloudFormation it emits.

`expectFlow` goes one level further — it asserts a **combination of building
blocks** as one sentence ("this handler reads that table and sends to that
queue"). It is a sound `AND` of typed edges between the constructs you name (it
composes `expectGrant` under the hood), not a graph search, so a passing flow
means every hop genuinely holds. v1 verbs: `reads`/`writes` (DynamoDB, S3),
`sendsTo` (SQS), `publishesTo` (SNS); drop to `expectGrant(...).can(...)` for
anything else.

### How `toMatchProps` stays correct AND type-safe

The expectation is written in the L1 **authoring** shape (`camelCase`
`CfnXxxProps`), which is what gives you autocomplete and compile-time checks.
For matching, each referenced property is read **from the L1 construct instance
and token-resolved** — not pulled from the `PascalCase` template. This avoids
any camelCase↔PascalCase translation heuristic and keeps free-form map keys
(env vars, tags) intact.

## Examples

All examples assume `const tree = ConstructTree.fromStack(stack);`.

### Querying the tree

```ts
// Count / existence by type — no "AWS::S3::Bucket" magic strings.
tree.findByType(s3.Bucket).expectCount(2);
tree.findByType(sqs.Queue).toExist();
tree.findByType(iam.User).toBeEmpty();

// Narrow with a typed predicate, then select.
tree
  .findByType(s3.Bucket)
  .where((b) => b.node.id === "Assets")
  .one();

// Run an assertion over every match.
tree.findByType(s3.Bucket).forEach((b) => b.hasRemovalPolicy(cdk.RemovalPolicy.RETAIN));
```

### Properties: L2, L1, and overrides

```ts
const fn = tree.findByType(lambda.Function).one();

// L2 public property (typed name + value).
fn.expectProperty("runtime", (r) => r === lambda.Runtime.NODEJS_20_X);

// L1 props in the camelCase CfnXxxProps shape (token-resolved, Match.* allowed).
fn.defaultResource(lambda.CfnFunction).toMatchProps({
  timeout: 30,
  memorySize: 256,
  environment: { variables: { TABLE_NAME: Match.anyValue() } },
});

const bucketL1 = tree.findByType(s3.Bucket).one().defaultResource(s3.CfnBucket);

// "this optional property was not set" (conditional-exclusion intent).
bucketL1.expectNoProperty("websiteConfiguration");

// Rendered template, AFTER addPropertyOverride / addDeletionOverride
// (which toMatchProps cannot see, because it reads the instance).
bucketL1.expectCfnPath("BucketName", "my-explicit-name");
bucketL1.expectCfnPath(["VersioningConfiguration", "Status"], "Enabled");
bucketL1.expectCfnPathAbsent("AccelerateConfiguration");

// CloudFormation resource attributes (not Properties).
bucketL1.hasRemovalPolicy(cdk.RemovalPolicy.RETAIN);
bucketL1.hasDeletionPolicy("Retain");
```

### Array-valued config (order-independent)

```ts
const bucketL1 = tree.findByType(s3.Bucket).one().defaultResource(s3.CfnBucket);

// Top-level array property.
bucketL1
  .collection<s3.CfnBucket.MetricsConfigurationProperty>("metricsConfigurations")
  .expectCount(2)
  .where((m) => m.id === "Images")
  .one()
  .toMatchProps({ prefix: "images/" });

// Nested array — resolve step by step via a path (handles lazy tokens).
bucketL1
  .collection<s3.CfnBucket.RuleProperty>(["lifecycleConfiguration", "rules"])
  .where((r) => r.id === "archive")
  .one()
  .toMatchProps({ expirationInDays: 365 });
```

### IAM grants (principal side)

```ts
// bucket.grantRead(fn) somewhere in the stack:
expectGrant(tree).principal(fn).can("s3:GetObject").on(bucket);
expectGrant(tree).principal(fn).can("s3:GetObject", "s3:ListBucket").on(bucket);

// Actions are type-checked against the AWS Service Reference — a typo
// ("s3:GetObjekt") or unknown-service wildcard fails to compile.
```

### Resource-side policies (the mirror of `expectGrant`)

```ts
// S3 security shortcuts (enforceSSL / minimumTLSVersion).
expectBucketPolicy(tree).of(bucket).deniesInsecureTransport().deniesTlsBelow(1.2);

// Generic resource policy — bucket policy, KMS key policy, SQS/SNS policy …
expectResourcePolicy(tree).of(bucket).allows({ service: "logs.amazonaws.com" }).to("s3:PutObject");

expectResourcePolicy(tree).of(key).allows({ aws: "*" }).to("kms:Decrypt");

// The core "absence" guarantee.
expectResourcePolicy(tree).of(bucket).hasNoStatement({ effect: "Allow", principal: "*" });
```

### Connectivity & encryption

```ts
expectConnection(tree).from(loadBalancer).to(service).onPort(443);
expectConnection(tree).from(bastion).to(database).onAnyPort();

expectEncryption(tree).of(bucket).withKey(key);
expectEncryption(tree).of(queue).withKey(key);
```

### Behavior: events, schedules, routes

```ts
// fn.addEventSource(new SqsEventSource(queue)):
expectEventSource(tree).of(fn).from(queue);
expectNoEventSource(tree).of(fn).from(unrelatedQueue);

// rule.addTarget(new LambdaFunction(fn)) with a rate/cron schedule:
expectSchedule(tree).rule(cron).triggers(fn);
expectSchedule(tree).rule(cron).triggers(fn).onSchedule("rate(1 hour)");

// REST API Gateway: GET /users/{id} → fn (path reconstructed, no logical ids).
expectRoute(tree).api(api).method("GET", "/users/{id}").to(fn);
expectNoRoute(tree).api(api).method("DELETE", "/users").to(fn);
```

### Building-block flows (combinations as one sentence)

```ts
// "the handler reads the table and sends to the queue".
expectFlow(tree).from(fn).reads(table).sendsTo(queue);

// The subject carries forward; andThen(x) switches the actor.
expectFlow(tree)
  .from(apiHandler)
  .reads(table)
  .sendsTo(jobQueue)
  .andThen(worker)
  .writes(table)
  .publishesTo(topic);
```

### Negative assertions (verifying absence)

```ts
tree.findByType(iam.User).toBeEmpty();
bucketL1.expectNoProperty("publicAccessBlockConfiguration");
expectResourcePolicy(tree).of(bucket).hasNoStatement({ effect: "Allow", principal: "*" });
expectNoEventSource(tree).of(fn).from(queue);
expectNoRoute(tree).api(api).method("POST", "/admin").to(fn);
```

### Escape hatch

When an assertion does not exist yet, drop to the real, fully-typed instance:

```ts
fn.satisfies((f) => expect(f.isBoundToVpc).toBe(false));
bucketL1.satisfies((b) => expect(b.cfnResourceType).toBe("AWS::S3::Bucket"));
```

## Scope / limitations (v1)

- **TypeScript-only.** The type safety depends on jsii-incompatible features.
- **`findByType` matches own constructs.** Resources imported via
  `fromXxxArn()` are anonymous subclasses and won't match the concrete class.
- **Single stack.** `fromApp` / cross-stack references are future work.
- **`expectGrant`** checks for an `Allow` statement whose actions match and
  whose `Resource` references the target (or is `*`). Conditions and `Deny`
  semantics are out of scope.
- **`expectConnection`** matches security-group-to-security-group rules
  (ingress on the target or egress on the source, inline or standalone). CIDR
  peers (e.g. `anyIpv4()`) are intentionally not treated as a connection
  between two constructs.
- **`expectEncryption`** confirms the resource references the key; it does not
  assert the specific encryption algorithm.

## Development

```sh
vp install   # install dependencies
vp test      # run the behavioral tests (vitest)
vp check     # format + lint + type check (also enforces the type-level tests)
vp pack      # build dist/
```

The type-level tests live in `tests/types/` and use `@ts-expect-error` to assert
that incorrect usage fails to compile; they are enforced by `vp check`.
