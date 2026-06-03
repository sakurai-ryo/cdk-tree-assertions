import type { ConstructTree } from "../construct-tree.ts";
import type { ConstructIndex } from "../private/index-model.ts";
import { idMatches } from "../private/intrinsics.ts";
import { securityGroupIdsOf, toConstruct, type SubjectOrConstruct } from "./util.ts";

/**
 * Start a type-safe security-group connectivity assertion:
 *
 * @example
 * expectConnection(tree).from(loadBalancer).to(service).onPort(443);
 */
export function expectConnection(tree: ConstructTree): ConnectionAssertion {
  return new ConnectionAssertion(tree.index);
}

interface SgRule {
  readonly direction: "ingress" | "egress";
  /** The security group the rule lives on (bare logical id or intrinsic). */
  readonly groupId: any;
  /** The other end of the rule (`Source`/`Destination` SecurityGroupId). */
  readonly peerId: any;
  readonly fromPort?: number;
  readonly toPort?: number;
  readonly protocol?: any;
}

/**
 * Asserts that one construct can reach another over a security-group rule.
 *
 * A connection `from(A).to(B)` is satisfied by either an **ingress** rule on
 * B's security group whose source is A, or an **egress** rule on A's security
 * group whose destination is B — covering both inline and standalone rules.
 *
 * Reads as the intent ("A can reach B on 443"), which is far easier to review
 * than the equivalent `AWS::EC2::SecurityGroupIngress` template assertion.
 */
export class ConnectionAssertion {
  private _from?: ReturnType<typeof toConstruct>;
  private _to?: ReturnType<typeof toConstruct>;

  constructor(private readonly index: ConstructIndex) {}

  /** The source (initiating) construct. */
  public from(source: SubjectOrConstruct): this {
    this._from = toConstruct(source);
    return this;
  }

  /** The destination (receiving) construct. */
  public to(target: SubjectOrConstruct): this {
    this._to = toConstruct(target);
    return this;
  }

  /** Assert connectivity on a specific port. */
  public onPort(port: number): void {
    this.assertConnectable(port);
  }

  /** Assert connectivity on any port (e.g. an all-traffic rule). */
  public onAnyPort(): void {
    this.assertConnectable(undefined);
  }

  private assertConnectable(port: number | undefined): void {
    if (!this._from || !this._to) {
      throw new Error("expectConnection: from() and to() must be called before onPort()");
    }

    const fromIds = securityGroupIdsOf(this._from, this.index);
    const toIds = securityGroupIdsOf(this._to, this.index);

    if (fromIds.size === 0 || toIds.size === 0) {
      throw new Error(
        `expectConnection: could not find security groups for ` +
          `${fromIds.size === 0 ? this._from.node.path : this._to.node.path}`,
      );
    }

    const ok = this.collectRules().some((rule) => {
      if (!portMatches(rule, port)) {
        return false;
      }
      if (rule.direction === "ingress") {
        return idMatches(rule.groupId, toIds) && idMatches(rule.peerId, fromIds);
      }
      return idMatches(rule.groupId, fromIds) && idMatches(rule.peerId, toIds);
    });

    if (!ok) {
      throw new Error(
        `Expected ${this._from.node.path} to be able to connect to ${this._to.node.path} ` +
          `on ${port === undefined ? "any port" : `port ${port}`}, ` +
          "but no matching security group rule was found",
      );
    }
  }

  private collectRules(): SgRule[] {
    const rules: SgRule[] = [];

    for (const cfn of this.index.cfnResourcesUnder(this.index.stack)) {
      const props = this.index.resolvedPropertiesOf(cfn);

      switch (cfn.cfnResourceType) {
        case "AWS::EC2::SecurityGroup": {
          const ownId = this.index.logicalIdOf(cfn);
          for (const r of props.SecurityGroupIngress ?? []) {
            rules.push({
              direction: "ingress",
              groupId: ownId,
              peerId: r.SourceSecurityGroupId,
              ...ports(r),
            });
          }
          for (const r of props.SecurityGroupEgress ?? []) {
            rules.push({
              direction: "egress",
              groupId: ownId,
              peerId: r.DestinationSecurityGroupId,
              ...ports(r),
            });
          }
          break;
        }
        case "AWS::EC2::SecurityGroupIngress":
          rules.push({
            direction: "ingress",
            groupId: props.GroupId,
            peerId: props.SourceSecurityGroupId,
            ...ports(props),
          });
          break;
        case "AWS::EC2::SecurityGroupEgress":
          rules.push({
            direction: "egress",
            groupId: props.GroupId,
            peerId: props.DestinationSecurityGroupId,
            ...ports(props),
          });
          break;
        default:
          break;
      }
    }

    return rules;
  }
}

function ports(rule: any): { fromPort?: number; toPort?: number; protocol?: any } {
  return { fromPort: rule.FromPort, toPort: rule.ToPort, protocol: rule.IpProtocol };
}

function portMatches(rule: SgRule, port: number | undefined): boolean {
  // IpProtocol "-1" means all traffic / all ports.
  if (rule.protocol === "-1" || rule.protocol === -1) {
    return true;
  }
  if (port === undefined) {
    return true;
  }
  if (typeof rule.fromPort === "number" && typeof rule.toPort === "number") {
    return rule.fromPort <= port && port <= rule.toPort;
  }
  return false;
}
