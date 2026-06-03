import { CfnResource, type Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import type { IConstruct } from "constructs";

/**
 * The cornerstone of the library.
 *
 * Built once per {@link ConstructTree}, it bridges three views of the same
 * stack so every higher-level assertion can move between them:
 *
 *  - typed Construct instances (from the construct tree)
 *  - CloudFormation logical ids
 *  - fully resolved CloudFormation properties (tokens already resolved)
 *
 * Token resolution is NOT reimplemented here: an internal
 * `assertions.Template` instance provides the resolved JSON via the same,
 * battle-tested synthesis path used by `Template.fromStack`.
 */
export class ConstructIndex {
  /** Resolved CloudFormation template, lazily materialized. */
  private _json?: { [key: string]: any };

  private readonly _template: Template;
  private readonly _logicalIdByCfn = new Map<CfnResource, string>();
  private readonly _cfnByLogicalId = new Map<string, CfnResource>();

  constructor(public readonly stack: Stack) {
    this._template = Template.fromStack(stack);

    for (const c of stack.node.findAll()) {
      if (CfnResource.isCfnResource(c)) {
        const logicalId = stack.resolve(c.logicalId);
        if (typeof logicalId === "string") {
          this._logicalIdByCfn.set(c, logicalId);
          this._cfnByLogicalId.set(logicalId, c);
        }
      }
    }
  }

  /** The full resolved CloudFormation template as JSON. */
  public get templateJson(): { [key: string]: any } {
    if (!this._json) {
      this._json = this._template.toJSON();
    }
    return this._json;
  }

  /** Resolved CloudFormation logical id of an L1 resource. */
  public logicalIdOf(cfn: CfnResource): string {
    const id = this._logicalIdByCfn.get(cfn);
    if (!id) {
      throw new Error(`Could not determine logical id for resource at ${cfn.node.path}`);
    }
    return id;
  }

  /** Resolved logical id of an L1 resource, or `undefined` if it is not in this stack (e.g. imported). */
  public tryLogicalIdOf(cfn: CfnResource): string | undefined {
    return this._logicalIdByCfn.get(cfn);
  }

  /** The L1 resource for a logical id, if it belongs to this stack. */
  public constructOf(logicalId: string): CfnResource | undefined {
    return this._cfnByLogicalId.get(logicalId);
  }

  /** Resolved `Resources.<logicalId>` entry of the template. */
  public resolvedResourceOf(cfn: CfnResource): { [key: string]: any } {
    const id = this.logicalIdOf(cfn);
    const resource = this.templateJson.Resources?.[id];
    if (!resource) {
      throw new Error(`Resource ${id} (${cfn.node.path}) not found in synthesized template`);
    }
    return resource;
  }

  /** Resolved `Properties` of an L1 resource (empty object if it has none). */
  public resolvedPropertiesOf(cfn: CfnResource): { [key: string]: any } {
    return this.resolvedResourceOf(cfn).Properties ?? {};
  }

  /** All `CfnResource`s in the subtree rooted at `root` (inclusive). */
  public cfnResourcesUnder(root: IConstruct): CfnResource[] {
    return root.node.findAll().filter((c): c is CfnResource => CfnResource.isCfnResource(c));
  }

  /** Resolved logical ids of every `CfnResource` in the subtree rooted at `root`. */
  public logicalIdsUnder(root: IConstruct): Set<string> {
    return new Set(this.cfnResourcesUnder(root).map((c) => this.logicalIdOf(c)));
  }
}
