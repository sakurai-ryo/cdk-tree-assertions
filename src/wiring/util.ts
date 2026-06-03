import { CfnResource } from "aws-cdk-lib";
import type { IConstruct } from "constructs";
import type { ConstructIndex } from "../private/index-model.ts";
import { ConstructSubject } from "../subject.ts";

/** A wiring assertion accepts either a {@link ConstructSubject} or a raw construct. */
export type SubjectOrConstruct = ConstructSubject<any> | IConstruct;

/** Unwrap a {@link ConstructSubject} to its underlying construct. */
export function toConstruct(value: SubjectOrConstruct): IConstruct {
  return value instanceof ConstructSubject ? value.actual : value;
}

/**
 * Resolved logical ids of the security group(s) backing a construct.
 *
 * Reads `connections.securityGroups` when the construct exposes
 * `IConnectable`, and falls back to any `AWS::EC2::SecurityGroup` in its
 * subtree. Imported security groups (no logical id in this stack) are skipped.
 */
export function securityGroupIdsOf(construct: IConstruct, index: ConstructIndex): Set<string> {
  const ids = new Set<string>();

  const connections = (construct as { connections?: { securityGroups?: IConstruct[] } })
    .connections;
  for (const sg of connections?.securityGroups ?? []) {
    const def = sg.node?.defaultChild;
    if (def && CfnResource.isCfnResource(def)) {
      addId(ids, index.tryLogicalIdOf(def));
    }
  }

  for (const cfn of index.cfnResourcesUnder(construct)) {
    if (cfn.cfnResourceType === "AWS::EC2::SecurityGroup") {
      addId(ids, index.tryLogicalIdOf(cfn));
    }
  }

  return ids;
}

function addId(set: Set<string>, id: string | undefined): void {
  if (id) {
    set.add(id);
  }
}
