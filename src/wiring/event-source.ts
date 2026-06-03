import type { ConstructTree } from "../construct-tree.ts";
import type { ConstructIndex } from "../private/index-model.ts";
import { referencesAnyLogicalId } from "../private/intrinsics.ts";
import { toConstruct, type SubjectOrConstruct } from "./util.ts";

/**
 * Start a type-safe Lambda event-source assertion — the behavioral intent
 * "this function is triggered by this source", instead of hand-tracing an
 * `AWS::Lambda::EventSourceMapping`'s `EventSourceArn`.
 *
 * @example
 * expectEventSource(tree).of(fn).from(queue);
 */
export function expectEventSource(tree: ConstructTree): EventSourceAssertion {
  return new EventSourceAssertion(tree.index, false);
}

/** The negative form: assert the function is NOT wired to the given source. */
export function expectNoEventSource(tree: ConstructTree): EventSourceAssertion {
  return new EventSourceAssertion(tree.index, true);
}

/**
 * Asserts that a Lambda function consumes events from a source (SQS queue,
 * Kinesis/DynamoDB stream, …) via an `AWS::Lambda::EventSourceMapping` whose
 * `FunctionName` resolves to the function and whose `EventSourceArn` resolves to
 * the source — both matched by intrinsic logical-id reference, so no ARN tracing.
 *
 * S3 notifications are not event-source mappings (they go through a custom
 * resource) and are out of scope here.
 */
export class EventSourceAssertion {
  private _fn?: ReturnType<typeof toConstruct>;

  constructor(
    private readonly index: ConstructIndex,
    private readonly negate: boolean,
  ) {}

  /** The consuming Lambda function. */
  public of(fn: SubjectOrConstruct): this {
    this._fn = toConstruct(fn);
    return this;
  }

  /** The event source the function must (not) consume. Performs the assertion. */
  public from(source: SubjectOrConstruct): void {
    if (!this._fn) {
      throw new Error("expectEventSource: of() must be called before from()");
    }

    const fnIds = this.index.logicalIdsUnder(this._fn);
    const sourceConstruct = toConstruct(source);
    const sourceIds = this.index.logicalIdsUnder(sourceConstruct);

    const found = this.eventSourceMappings().some(
      (m) =>
        referencesAnyLogicalId(m.FunctionName, fnIds) &&
        referencesAnyLogicalId(m.EventSourceArn, sourceIds),
    );

    if (found === this.negate) {
      const fnPath = this._fn.node.path;
      const sourcePath = sourceConstruct.node.path;
      throw new Error(
        this.negate
          ? `Expected ${fnPath} not to consume events from ${sourcePath}, but an EventSourceMapping was found`
          : `Expected ${fnPath} to consume events from ${sourcePath}, but no EventSourceMapping linking them was found`,
      );
    }
  }

  /** Resolved `{ FunctionName, EventSourceArn }` of every event-source mapping. */
  private eventSourceMappings(): Array<{ FunctionName: any; EventSourceArn: any }> {
    return this.index
      .cfnResourcesUnder(this.index.stack)
      .filter((cfn) => cfn.cfnResourceType === "AWS::Lambda::EventSourceMapping")
      .map(
        (cfn) => this.index.resolvedPropertiesOf(cfn) as { FunctionName: any; EventSourceArn: any },
      );
  }
}
