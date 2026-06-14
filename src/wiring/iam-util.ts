import type { CfnResource } from "aws-cdk-lib";
import type { IConstruct } from "constructs";
import type { ConstructIndex } from "../private/index-model.ts";
import { collectReferencedLogicalIds, referencesAnyLogicalId } from "../private/intrinsics.ts";

/**
 * Shared principal-side IAM plumbing for `expectGrant` / `expectNoWildcard`:
 * resolving a principal to its role(s) and collecting every policy statement
 * that applies to them, keeping the source resource for path-centric errors.
 */

/** A policy statement together with the policy resource it came from. */
export interface SourcedStatement {
  readonly statement: any;
  /** The CFN resource carrying the statement (role, policy, or managed policy). */
  readonly source: CfnResource;
}

/** Resolved logical ids of the IAM role(s) backing a principal. */
export function roleLogicalIdsOf(principal: IConstruct, index: ConstructIndex): Set<string> {
  const roles = new Set<string>();

  // Roles created within the principal's subtree (e.g. Lambda's ServiceRole).
  for (const cfn of index.cfnResourcesUnder(principal)) {
    if (cfn.cfnResourceType === "AWS::IAM::Role") {
      roles.add(index.logicalIdOf(cfn));
    }
  }

  // An explicit `.role` property pointing at a role construct elsewhere.
  const role = (principal as { role?: IConstruct }).role;
  if (role?.node) {
    for (const cfn of index.cfnResourcesUnder(role)) {
      if (cfn.cfnResourceType === "AWS::IAM::Role") {
        roles.add(index.logicalIdOf(cfn));
      }
    }
  }

  return roles;
}

/**
 * Every policy statement that applies to the given roles: the roles' inline
 * `Policies`, attached `AWS::IAM::Policy` resources, and in-stack
 * `AWS::IAM::ManagedPolicy` resources (attached via the policy's `Roles` or
 * the roles' `ManagedPolicyArns`). AWS-managed policy ARNs are not resolvable
 * from the template and are not inspected.
 */
export function principalStatementsOf(
  roleIds: Set<string>,
  index: ConstructIndex,
): SourcedStatement[] {
  const out: SourcedStatement[] = [];

  // In-stack managed policies referenced from the roles' ManagedPolicyArns.
  const managedPolicyIds = new Set<string>();
  for (const cfn of index.cfnResourcesUnder(index.stack)) {
    if (cfn.cfnResourceType === "AWS::IAM::Role" && roleIds.has(index.logicalIdOf(cfn))) {
      const arns = index.resolvedPropertiesOf(cfn).ManagedPolicyArns;
      for (const id of collectReferencedLogicalIds(arns)) {
        managedPolicyIds.add(id);
      }
    }
  }

  for (const cfn of index.cfnResourcesUnder(index.stack)) {
    const type = cfn.cfnResourceType;
    const props = index.resolvedPropertiesOf(cfn);

    if (type === "AWS::IAM::Role" && roleIds.has(index.logicalIdOf(cfn))) {
      for (const policy of props.Policies ?? []) {
        pushStatements(out, policy.PolicyDocument, cfn);
      }
    }

    if (type === "AWS::IAM::Policy" && referencesAnyLogicalId(props.Roles, roleIds)) {
      pushStatements(out, props.PolicyDocument, cfn);
    }

    if (
      type === "AWS::IAM::ManagedPolicy" &&
      (managedPolicyIds.has(index.logicalIdOf(cfn)) || referencesAnyLogicalId(props.Roles, roleIds))
    ) {
      pushStatements(out, props.PolicyDocument, cfn);
    }
  }

  return out;
}

/** The `Statement` array of a policy document (normalized, empty when absent). */
export function statementsOf(policyDocument: any): any[] {
  const statement = policyDocument?.Statement;
  if (Array.isArray(statement)) return statement;
  return statement ? [statement] : [];
}

/** Normalize a scalar-or-array statement field to an array. */
export function toArray(value: any): any[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function pushStatements(out: SourcedStatement[], policyDocument: any, source: CfnResource): void {
  for (const statement of statementsOf(policyDocument)) {
    out.push({ statement, source });
  }
}
