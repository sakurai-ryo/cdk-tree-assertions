import type { ConstructTree } from "../construct-tree.ts";
import type { ConstructIndex } from "../private/index-model.ts";
import { referencesAnyLogicalId } from "../private/intrinsics.ts";
import { toConstruct, type SubjectOrConstruct } from "./util.ts";

/**
 * Start a type-safe schedule assertion — the behavioral intent "this EventBridge
 * rule runs this target on a schedule", instead of reading an `AWS::Events::Rule`
 * `Targets` array and `ScheduleExpression` by hand.
 *
 * @example
 * expectSchedule(tree).rule(cron).triggers(fn);
 * expectSchedule(tree).rule(cron).triggers(fn).onSchedule("rate(1 hour)");
 */
export function expectSchedule(tree: ConstructTree): ScheduleAssertion {
  return new ScheduleAssertion(tree.index, false);
}

/** The negative form: assert the rule does NOT trigger the target on a schedule. */
export function expectNoSchedule(tree: ConstructTree): ScheduleAssertion {
  return new ScheduleAssertion(tree.index, true);
}

/**
 * Asserts that a scheduled EventBridge rule invokes a target. A rule matches
 * when it carries a `ScheduleExpression` (so event-pattern rules are excluded)
 * and one of its `Targets` references the target construct. Both ends are
 * matched by intrinsic logical-id reference.
 */
export class ScheduleAssertion {
  private _rule?: ReturnType<typeof toConstruct>;
  private _target?: ReturnType<typeof toConstruct>;
  private _schedule?: string;

  constructor(
    private readonly index: ConstructIndex,
    private readonly negate: boolean,
  ) {}

  /** The EventBridge rule. */
  public rule(rule: SubjectOrConstruct): this {
    this._rule = toConstruct(rule);
    return this;
  }

  /** The target the rule must (not) trigger. Performs the assertion. */
  public triggers(target: SubjectOrConstruct): this {
    this._target = toConstruct(target);
    return this.assert();
  }

  /** Additionally require the rule's `ScheduleExpression` to equal `expression`. */
  public onSchedule(expression: string): this {
    this._schedule = expression;
    return this.assert();
  }

  private assert(): this {
    if (!this._rule) {
      throw new Error("expectSchedule: rule() must be called before triggers()");
    }
    if (!this._target) {
      throw new Error("expectSchedule: triggers() must be called before onSchedule()");
    }

    const targetIds = this.index.logicalIdsUnder(this._target);
    const found = this.scheduleRules().some(
      (props) =>
        typeof props.ScheduleExpression === "string" &&
        (this._schedule === undefined || props.ScheduleExpression === this._schedule) &&
        referencesAnyLogicalId(props.Targets, targetIds),
    );

    if (found === this.negate) {
      const rulePath = this._rule.node.path;
      const targetPath = this._target.node.path;
      const sched = this._schedule === undefined ? "" : ` on schedule '${this._schedule}'`;
      throw new Error(
        this.negate
          ? `Expected ${rulePath} not to trigger ${targetPath}${sched}, but a matching scheduled target was found`
          : `Expected ${rulePath} to trigger ${targetPath}${sched}, but no scheduled rule targeting it was found`,
      );
    }
    return this;
  }

  /** Resolved properties of every `AWS::Events::Rule` under the rule construct. */
  private scheduleRules(): Array<{ ScheduleExpression?: any; Targets?: any }> {
    return this.index
      .cfnResourcesUnder(this._rule!)
      .filter((cfn) => cfn.cfnResourceType === "AWS::Events::Rule")
      .map((cfn) => this.index.resolvedPropertiesOf(cfn));
  }
}
