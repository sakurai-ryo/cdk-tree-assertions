import type { ConstructTree } from "../construct-tree.ts";
import type { IamAction } from "../private/iam-action.ts";
import type { ConstructIndex } from "../private/index-model.ts";
import { wildcardCovers } from "../private/intrinsics.ts";
import { principalStatementsOf, roleLogicalIdsOf, toArray } from "./iam-util.ts";
import { toConstruct, type SubjectOrConstruct } from "./util.ts";

/**
 * Start a wildcard-absence assertion over a principal's IAM policies:
 *
 * @example
 * expectNoWildcard(tree).inPoliciesOf(fn);
 * expectNoWildcard(tree).except("xray:*").inPoliciesOf(fn);
 */
export function expectNoWildcard(tree: ConstructTree): NoWildcardAssertion {
  return new NoWildcardAssertion(tree.index);
}

/**
 * Asserts that no `Allow` statement in the principal's policies uses a full
 * wildcard: `Action: "*"`, a whole-service action (`"s3:*"`), or
 * `Resource: "*"`.
 *
 * Partial action wildcards (`s3:GetObject*`, `s3:List*`) are deliberately NOT
 * flagged — they are the idiom CDK's own `grant*()` methods emit. `Deny`
 * statements are skipped (a wildcard Deny is protective). Statements whose
 * actions are all covered by an {@link except} pattern are exempt, which is
 * how legitimately resource-less actions (`xray:*`, `logs:*`, …) are allowed.
 */
export class NoWildcardAssertion {
  private readonly _except: IamAction[] = [];

  constructor(private readonly index: ConstructIndex) {}

  /** Exempt statements whose actions are all covered by one of these patterns. */
  public except(...actions: IamAction[]): this {
    this._except.push(...actions);
    return this;
  }

  /** Scan every policy statement attached to the principal's role(s). Performs the assertion. */
  public inPoliciesOf(principal: SubjectOrConstruct): void {
    const construct = toConstruct(principal);
    const roleIds = roleLogicalIdsOf(construct, this.index);

    if (roleIds.size === 0) {
      throw new Error(
        `expectNoWildcard: could not find an IAM role for principal ${construct.node.path}`,
      );
    }

    const findings: string[] = [];
    for (const { statement, source } of principalStatementsOf(roleIds, this.index)) {
      if (statement?.Effect !== "Allow" || this.isExempt(statement)) {
        continue;
      }

      const actions = toArray(statement.Action).filter((a): a is string => typeof a === "string");
      const fullWildcards = actions.filter((a) => a === "*" || /^[^:]+:\*$/.test(a));
      for (const action of fullWildcards) {
        findings.push(`  - ${source.node.path}: Action "${action}"`);
      }

      if (toArray(statement.Resource).includes("*")) {
        findings.push(`  - ${source.node.path}: Resource "*" (Action=[${actions.join(", ")}])`);
      }
    }

    if (findings.length > 0) {
      throw new Error(
        `Expected no wildcard in the policies of ${construct.node.path}, but found:\n` +
          `${findings.join("\n")}\n` +
          `(exempt legitimately resource-less actions with .except("service:*"))`,
      );
    }
  }

  /** A statement is exempt when every one of its actions is covered by an except pattern. */
  private isExempt(statement: any): boolean {
    if (this._except.length === 0) {
      return false;
    }
    const actions = toArray(statement.Action).filter((a): a is string => typeof a === "string");
    return (
      actions.length > 0 &&
      actions.every((a) => this._except.some((pattern) => wildcardCovers(pattern, a)))
    );
  }
}
