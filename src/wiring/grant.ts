import type { IConstruct } from "constructs";
import type { ConstructTree } from "../construct-tree.ts";
import type { IamAction } from "../private/iam-action.ts";
import type { ConstructIndex } from "../private/index-model.ts";
import { actionMatches, referencesAnyLogicalId } from "../private/intrinsics.ts";
import { principalStatementsOf, roleLogicalIdsOf, toArray } from "./iam-util.ts";
import { toConstruct, type SubjectOrConstruct } from "./util.ts";

/**
 * Start a type-safe IAM grant assertion:
 *
 * @example
 * expectGrant(tree).principal(fn).can("s3:GetObject").on(bucket);
 * expectGrant(tree).principal(fn).cannot("s3:DeleteObject").on(bucket);
 */
export function expectGrant(tree: ConstructTree): GrantAssertion {
  return new GrantAssertion(tree.index);
}

/**
 * Asserts that an IAM principal is (or is not) granted actions on a resource,
 * by inspecting the resolved policy documents attached to the principal's
 * role(s) and mapping `Resource` intrinsics back to the target construct.
 *
 * v1 scope: checks for an `Allow` statement whose actions match and whose
 * resource references the target (or is `*`). Conditions and `Deny` semantics
 * are out of scope. In-stack managed policies are inspected; AWS-managed
 * policy ARNs are not.
 */
export class GrantAssertion {
  private _principal?: IConstruct;
  private _mode?: "can" | "cannot";
  private readonly _actions: IamAction[] = [];

  constructor(private readonly index: ConstructIndex) {}

  /** The grantee (e.g. a Lambda function, a role). */
  public principal(principal: SubjectOrConstruct): this {
    this._principal = toConstruct(principal);
    return this;
  }

  /** One or more IAM actions that must be granted (wildcards allowed). */
  public can(...actions: IamAction[]): this {
    this.setMode("can");
    this._actions.push(...actions);
    return this;
  }

  /**
   * One or more IAM actions that must NOT be granted — the negative guarantee
   * a reviewer cannot get from reading the policy JSON. A wildcard asserts the
   * absence of the whole family: `cannot("s3:*")` means "no s3 access at all".
   */
  public cannot(...actions: IamAction[]): this {
    this.setMode("cannot");
    this._actions.push(...actions);
    return this;
  }

  /** The resource the actions are checked against. Performs the assertion. */
  public on(target: SubjectOrConstruct): void {
    if (!this._principal) {
      throw new Error("expectGrant: principal() must be called before on()");
    }
    if (this._actions.length === 0) {
      throw new Error("expectGrant: can()/cannot() must specify at least one action before on()");
    }

    const targetConstruct = toConstruct(target);
    const targetIds = this.index.logicalIdsUnder(targetConstruct);
    const roleIds = roleLogicalIdsOf(this._principal, this.index);

    if (roleIds.size === 0) {
      // Also for cannot(): a principal without any role is almost certainly a
      // miswired test, and passing vacuously would hide it.
      throw new Error(
        `expectGrant: could not find an IAM role for principal ${this._principal.node.path}`,
      );
    }

    const sourced = principalStatementsOf(roleIds, this.index);

    if (this._mode === "cannot") {
      const offending = this._actions
        .map((action) => ({
          action,
          sources: sourced
            .filter(({ statement }) => statementGrants(statement, action, targetIds))
            .map(({ source }) => source.node.path),
        }))
        .filter((o) => o.sources.length > 0);

      if (offending.length > 0) {
        const lines = offending.map(
          (o) => `  - ${o.action} (allowed by ${[...new Set(o.sources)].join(", ")})`,
        );
        throw new Error(
          `Expected ${this._principal.node.path} NOT to be granted ` +
            `[${offending.map((o) => o.action).join(", ")}] on ${targetConstruct.node.path}, ` +
            `but matching Allow statement(s) were found:\n${lines.join("\n")}`,
        );
      }
      return;
    }

    const missing = this._actions.filter(
      (action) => !sourced.some(({ statement }) => statementGrants(statement, action, targetIds)),
    );

    if (missing.length > 0) {
      throw new Error(
        `Expected ${this._principal.node.path} to be granted [${missing.join(", ")}] ` +
          `on ${targetConstruct.node.path}, but no matching Allow statement was found ` +
          `(checked ${sourced.length} statement(s) across ${roleIds.size} role(s))`,
      );
    }
  }

  private setMode(mode: "can" | "cannot"): void {
    if (this._mode && this._mode !== mode) {
      throw new Error(
        "expectGrant: can() and cannot() must not be mixed in one assertion; " +
          "use two expectGrant() calls",
      );
    }
    this._mode = mode;
  }
}

function statementGrants(statement: any, action: string, targetIds: Set<string>): boolean {
  if (statement?.Effect !== "Allow") {
    return false;
  }

  const actions = toArray(statement.Action);
  if (!actions.some((a) => typeof a === "string" && actionMatches(action, a))) {
    return false;
  }

  return resourceMatches(statement.Resource, targetIds);
}

function resourceMatches(resource: any, targetIds: Set<string>): boolean {
  return toArray(resource).some((r) => r === "*" || referencesAnyLogicalId(r, targetIds));
}
