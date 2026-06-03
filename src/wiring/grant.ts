import type { CfnResource } from "aws-cdk-lib";
import type { IConstruct } from "constructs";
import type { ConstructTree } from "../construct-tree.ts";
import type { IamAction } from "../private/iam-action.ts";
import type { ConstructIndex } from "../private/index-model.ts";
import { actionMatches, referencesAnyLogicalId } from "../private/intrinsics.ts";
import { toConstruct, type SubjectOrConstruct } from "./util.ts";

/** Start a type-safe IAM grant assertion: `expectGrant(tree).principal(fn).can('s3:GetObject').on(bucket)`. */
export function expectGrant(tree: ConstructTree): GrantAssertion {
  return new GrantAssertion(tree.index);
}

/**
 * Asserts that an IAM principal is granted actions on a resource, by inspecting
 * the resolved policy documents attached to the principal's role(s) and mapping
 * `Resource` intrinsics back to the target construct.
 *
 * v1 scope: checks for an `Allow` statement whose actions match and whose
 * resource references the target (or is `*`). Conditions and `Deny` semantics
 * are out of scope.
 */
export class GrantAssertion {
  private _principal?: IConstruct;
  private readonly _actions: IamAction[] = [];

  constructor(private readonly index: ConstructIndex) {}

  /** The grantee (e.g. a Lambda function, a role). */
  public principal(principal: SubjectOrConstruct): this {
    this._principal = toConstruct(principal);
    return this;
  }

  /** One or more IAM actions that must be granted (wildcards allowed). */
  public can(...actions: IamAction[]): this {
    this._actions.push(...actions);
    return this;
  }

  /** The resource the actions must be granted on. Performs the assertion. */
  public on(target: SubjectOrConstruct): void {
    if (!this._principal) {
      throw new Error("expectGrant: principal() must be called before on()");
    }
    if (this._actions.length === 0) {
      throw new Error("expectGrant: can() must specify at least one action before on()");
    }

    const targetConstruct = toConstruct(target);
    const targetIds = this.index.logicalIdsUnder(targetConstruct);
    const roleIds = this.roleLogicalIdsOf(this._principal);

    if (roleIds.size === 0) {
      throw new Error(
        `expectGrant: could not find an IAM role for principal ${this._principal.node.path}`,
      );
    }

    const statements = this.statementsForRoles(roleIds);
    const missing = this._actions.filter(
      (action) => !statements.some((s) => statementGrants(s, action, targetIds)),
    );

    if (missing.length > 0) {
      throw new Error(
        `Expected ${this._principal.node.path} to be granted [${missing.join(", ")}] ` +
          `on ${targetConstruct.node.path}, but no matching Allow statement was found ` +
          `(checked ${statements.length} statement(s) across ${roleIds.size} role(s))`,
      );
    }
  }

  /** Resolved logical ids of the role(s) backing a principal. */
  private roleLogicalIdsOf(principal: IConstruct): Set<string> {
    const roles = new Set<string>();

    // Roles created within the principal's subtree (e.g. Lambda's ServiceRole).
    for (const cfn of this.index.cfnResourcesUnder(principal)) {
      if (cfn.cfnResourceType === "AWS::IAM::Role") {
        roles.add(this.index.logicalIdOf(cfn));
      }
    }

    // An explicit `.role` property pointing at a role construct elsewhere.
    const role = (principal as { role?: IConstruct }).role;
    if (role?.node) {
      for (const cfn of this.index.cfnResourcesUnder(role)) {
        if (cfn.cfnResourceType === "AWS::IAM::Role") {
          roles.add(this.index.logicalIdOf(cfn));
        }
      }
    }

    return roles;
  }

  /** All policy statements (inline + attached) that apply to the given roles. */
  private statementsForRoles(roleIds: Set<string>): any[] {
    const statements: any[] = [];

    for (const cfn of allCfnResources(this.index)) {
      const type = cfn.cfnResourceType;
      const props = this.index.resolvedPropertiesOf(cfn);

      if (type === "AWS::IAM::Role" && roleIds.has(this.index.logicalIdOf(cfn))) {
        for (const policy of props.Policies ?? []) {
          statements.push(...statementsOf(policy.PolicyDocument));
        }
      }

      if (type === "AWS::IAM::Policy" && referencesAnyLogicalId(props.Roles, roleIds)) {
        statements.push(...statementsOf(props.PolicyDocument));
      }
    }

    return statements;
  }
}

function statementsOf(policyDocument: any): any[] {
  const statement = policyDocument?.Statement;
  if (Array.isArray(statement)) return statement;
  return statement ? [statement] : [];
}

function statementGrants(statement: any, action: string, targetIds: Set<string>): boolean {
  if (statement?.Effect !== "Allow") {
    return false;
  }

  const actions: string[] = Array.isArray(statement.Action)
    ? statement.Action
    : statement.Action
      ? [statement.Action]
      : [];
  if (!actions.some((a) => typeof a === "string" && actionMatches(action, a))) {
    return false;
  }

  return resourceMatches(statement.Resource, targetIds);
}

function resourceMatches(resource: any, targetIds: Set<string>): boolean {
  const resources = Array.isArray(resource) ? resource : [resource];
  return resources.some((r) => r === "*" || referencesAnyLogicalId(r, targetIds));
}

function allCfnResources(index: ConstructIndex): CfnResource[] {
  return index.cfnResourcesUnder(index.stack);
}
