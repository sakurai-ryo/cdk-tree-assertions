import { CfnResource } from "aws-cdk-lib";
import type { IConstruct } from "constructs";
import type { ConstructTree } from "../construct-tree.ts";
import type { IamAction } from "../private/iam-action.ts";
import { expectGrant } from "./grant.ts";
import { toConstruct, type SubjectOrConstruct } from "./util.ts";

/**
 * Start a behavioral **flow** assertion over a combination of building blocks —
 * "this actor reads that table, then sends to that queue" — reading as one
 * sentence instead of several separate grant checks.
 *
 * The subject carries forward: each verb keeps the current actor; `andThen(x)`
 * switches the actor to a new one. Each verb is a thin, sound composition of
 * {@link expectGrant} (an `AND` of typed edges between named constructs — not a
 * graph search), so a passing flow means every edge genuinely holds.
 *
 * v1 verbs map to a representative IAM action by the target's resource type:
 * `reads`/`writes` (DynamoDB, S3), `sendsTo` (SQS), `publishesTo` (SNS). For
 * anything else, drop to `expectGrant(...).can(...)`. Negative checks live at
 * the edge level (a flow is by nature a positive existence claim).
 *
 * @example
 * expectFlow(tree).from(fn).reads(table).sendsTo(queue);
 * expectFlow(tree).from(fn).reads(table).andThen(worker).publishesTo(topic);
 */
export function expectFlow(tree: ConstructTree): FlowAssertion {
  return new FlowAssertion(tree);
}

/** Entry point that binds the first actor. */
export class FlowAssertion {
  constructor(private readonly tree: ConstructTree) {}

  /** The first actor (a grantable principal, e.g. a Lambda function or role). */
  public from(actor: SubjectOrConstruct): FlowStep {
    return new FlowStep(this.tree, actor);
  }
}

// Representative action per resource type. Typed as plain strings (not the huge
// IamAction union) to avoid TS2590 on index access; cast to IamAction at the call.
const READ: Record<string, string> = {
  "AWS::DynamoDB::Table": "dynamodb:GetItem",
  "AWS::S3::Bucket": "s3:GetObject",
};
const WRITE: Record<string, string> = {
  "AWS::DynamoDB::Table": "dynamodb:PutItem",
  "AWS::S3::Bucket": "s3:PutObject",
};
const SEND: Record<string, string> = { "AWS::SQS::Queue": "sqs:SendMessage" };
const PUBLISH: Record<string, string> = { "AWS::SNS::Topic": "sns:Publish" };

/** A step in a flow, bound to the current actor; verbs assert and keep the actor. */
export class FlowStep {
  constructor(
    private readonly tree: ConstructTree,
    private readonly actor: SubjectOrConstruct,
  ) {}

  /** The actor reads the target (DynamoDB table / S3 bucket). */
  public reads(resource: SubjectOrConstruct): this {
    return this.grant("reads", READ, resource);
  }

  /** The actor writes the target (DynamoDB table / S3 bucket). */
  public writes(resource: SubjectOrConstruct): this {
    return this.grant("writes", WRITE, resource);
  }

  /** The actor sends messages to the target (SQS queue). */
  public sendsTo(resource: SubjectOrConstruct): this {
    return this.grant("sendsTo", SEND, resource);
  }

  /** The actor publishes to the target (SNS topic). */
  public publishesTo(resource: SubjectOrConstruct): this {
    return this.grant("publishesTo", PUBLISH, resource);
  }

  /** Continue the flow with a new actor. */
  public andThen(actor: SubjectOrConstruct): FlowStep {
    return new FlowStep(this.tree, actor);
  }

  private grant(
    verb: string,
    actionsByType: Record<string, string>,
    resource: SubjectOrConstruct,
  ): this {
    const target = toConstruct(resource);
    const type = primaryCfnType(target);
    const action = type ? actionsByType[type] : undefined;
    if (!action) {
      throw new Error(
        `expectFlow: .${verb}() supports [${Object.keys(actionsByType).join(", ")}], ` +
          `but ${target.node.path} is ${type ?? "an unsupported resource"} — ` +
          "drop to expectGrant(...).can(...) for it",
      );
    }

    try {
      expectGrant(this.tree)
        .principal(this.actor)
        .can(action as IamAction)
        .on(resource);
    } catch (error) {
      const actorPath = toConstruct(this.actor).node.path;
      throw new Error(
        `expectFlow: step "${actorPath} ${verb} ${target.node.path}" does not hold:\n${(error as Error).message}`,
      );
    }
    return this;
  }
}

/** The primary CloudFormation resource type of a construct (default child first). */
function primaryCfnType(construct: IConstruct): string | undefined {
  const def = construct.node.defaultChild;
  if (def && CfnResource.isCfnResource(def)) {
    return def.cfnResourceType;
  }
  for (const child of construct.node.findAll()) {
    if (CfnResource.isCfnResource(child)) {
      return child.cfnResourceType;
    }
  }
  return undefined;
}
