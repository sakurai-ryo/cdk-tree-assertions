import type { IConstruct } from "constructs";
import type { ConstructTree } from "../construct-tree.ts";
import type { ConstructIndex } from "../private/index-model.ts";
import { idMatches, referencesAnyLogicalId } from "../private/intrinsics.ts";
import { statementsOf, toArray } from "./iam-util.ts";
import { securityGroupIdsOf, toConstruct, type SubjectOrConstruct } from "./util.ts";

/**
 * Assert that nothing under a construct is exposed to the public internet:
 *
 * @example
 * expectNoPublicAccess(tree).of(database);
 *
 * Signals checked (all resolved through the index, no JSON tracing):
 *  - security group ingress from `0.0.0.0/0` / `::/0` (inline and standalone rules)
 *  - internet-facing ELBv2 load balancers
 *  - S3 buckets with a public ACL (`PublicRead` / `PublicReadWrite` / `AuthenticatedRead`)
 *  - Lambda function URLs with `AuthType: NONE`
 *  - publicly accessible RDS instances
 *  - resource policies that `Allow` `Principal: "*"` without any `Condition`
 *    (a conditioned star principal — e.g. `aws:SourceArn` — is scoped, not public;
 *    `Deny` statements like enforceSSL are protective and never flagged)
 *
 * Public *subnets* are deliberately not flagged: a standard VPC contains them
 * by design, and "is this workload placed in a private subnet" is a placement
 * assertion, not a public-access one.
 */
export function expectNoPublicAccess(tree: ConstructTree): PublicAccessAssertion {
  return new PublicAccessAssertion(tree.index, "absent");
}

/**
 * The positive dual of {@link expectNoPublicAccess}, for intentionally public
 * resources: asserts that at least one public-access signal exists.
 *
 * @example
 * expectPublicAccess(tree).of(publicAlb);
 */
export function expectPublicAccess(tree: ConstructTree): PublicAccessAssertion {
  return new PublicAccessAssertion(tree.index, "present");
}

export class PublicAccessAssertion {
  constructor(
    private readonly index: ConstructIndex,
    private readonly expectation: "absent" | "present",
  ) {}

  /** The construct (and its whole subtree) to inspect. Performs the assertion. */
  public of(target: SubjectOrConstruct): void {
    const construct = toConstruct(target);
    const findings = this.collectFindings(construct);

    if (this.expectation === "absent" && findings.length > 0) {
      throw new Error(
        `Expected no public access on ${construct.node.path}, but found:\n${findings.join("\n")}`,
      );
    }
    if (this.expectation === "present" && findings.length === 0) {
      throw new Error(
        `Expected ${construct.node.path} to be publicly accessible, ` +
          "but no public-access configuration was found",
      );
    }
  }

  private collectFindings(target: IConstruct): string[] {
    const findings: string[] = [];
    const targetIds = this.index.logicalIdsUnder(target);
    const sgIds = securityGroupIdsOf(target, this.index);

    for (const cfn of this.index.cfnResourcesUnder(this.index.stack)) {
      const props = this.index.resolvedPropertiesOf(cfn);
      const id = this.index.logicalIdOf(cfn);
      const inTarget = targetIds.has(id);
      const path = cfn.node.path;

      switch (cfn.cfnResourceType) {
        case "AWS::EC2::SecurityGroup": {
          if (!sgIds.has(id)) break;
          for (const rule of props.SecurityGroupIngress ?? []) {
            const cidr = publicCidrOf(rule);
            if (cidr) {
              findings.push(`  - ${path}: ingress from ${cidr} on ${describePorts(rule)}`);
            }
          }
          break;
        }
        case "AWS::EC2::SecurityGroupIngress": {
          if (!idMatches(props.GroupId, sgIds)) break;
          const cidr = publicCidrOf(props);
          if (cidr) {
            findings.push(`  - ${path}: ingress from ${cidr} on ${describePorts(props)}`);
          }
          break;
        }
        case "AWS::ElasticLoadBalancingV2::LoadBalancer":
          if (inTarget && props.Scheme === "internet-facing") {
            findings.push(`  - ${path}: internet-facing load balancer`);
          }
          break;
        case "AWS::S3::Bucket":
          if (inTarget && PUBLIC_ACLS.includes(props.AccessControl)) {
            findings.push(`  - ${path}: bucket ACL "${props.AccessControl}"`);
          }
          break;
        case "AWS::Lambda::Url":
          if (inTarget && props.AuthType === "NONE") {
            findings.push(`  - ${path}: function URL with AuthType NONE`);
          }
          break;
        case "AWS::RDS::DBInstance":
          if (inTarget && props.PubliclyAccessible === true) {
            findings.push(`  - ${path}: publicly accessible database instance`);
          }
          break;
        default:
          break;
      }

      // Resource policies: inline documents on resources under the target, and
      // dedicated `*Policy` resources pointing at the target.
      const documents: any[] = [];
      if (inTarget) {
        documents.push(props.KeyPolicy, props.PolicyDocument);
      } else if (
        cfn.cfnResourceType.endsWith("Policy") &&
        props.PolicyDocument &&
        referencesAnyLogicalId(props, targetIds)
      ) {
        documents.push(props.PolicyDocument);
      }
      for (const document of documents) {
        for (const statement of statementsOf(document)) {
          if (isUnconditionedPublicAllow(statement)) {
            const actions = toArray(statement.Action).join(", ");
            findings.push(
              `  - ${path}: policy allows Principal "*" without conditions (Action=[${actions}])`,
            );
          }
        }
      }
    }

    return findings;
  }
}

const PUBLIC_ACLS = ["PublicRead", "PublicReadWrite", "AuthenticatedRead"];

function isUnconditionedPublicAllow(statement: any): boolean {
  if (statement?.Effect !== "Allow") {
    return false;
  }
  const principal = statement.Principal;
  const isStar =
    principal === "*" || principal?.AWS === "*" || toArray(principal?.AWS).includes("*");
  if (!isStar) {
    return false;
  }
  return statement.Condition === undefined || Object.keys(statement.Condition).length === 0;
}

function publicCidrOf(rule: any): string | undefined {
  if (rule?.CidrIp === "0.0.0.0/0") return "0.0.0.0/0";
  if (rule?.CidrIpv6 === "::/0") return "::/0";
  return undefined;
}

function describePorts(rule: any): string {
  if (rule?.IpProtocol === "-1" || rule?.IpProtocol === -1) {
    return "all ports";
  }
  if (typeof rule?.FromPort === "number") {
    return rule.FromPort === rule.ToPort
      ? `port ${rule.FromPort}`
      : `ports ${rule.FromPort}-${rule.ToPort}`;
  }
  return "unspecified ports";
}
