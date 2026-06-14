import type { Stack } from "aws-cdk-lib";
import type { Template } from "aws-cdk-lib/assertions";
import type { IConstruct } from "constructs";
import { ConstructIndex } from "./private/index-model.ts";
import type { Constructor } from "./private/types.ts";
import { ConstructQuery } from "./query.ts";

/**
 * Entry point for type-safe assertions against a CDK Construct tree.
 *
 * `ConstructTree.fromStack(stack)` synthesizes the stack once (reusing the
 * `assertions` resolution path) and builds the {@link ConstructIndex} that
 * backs all downstream queries and wiring assertions.
 *
 * It is also a drop-in replacement for `aws-cdk-lib/assertions`' `Template`:
 * every `Template` assertion (`hasResourceProperties`, `resourceCountIs`,
 * `findResources`, …) is available with the same signature, so existing tests
 * migrate by swapping `Template.fromStack(stack)` for
 * `ConstructTree.fromStack(stack)` — and can then adopt the typed, intent-level
 * API incrementally.
 *
 * @example
 * const tree = ConstructTree.fromStack(stack);
 * tree.findByType(s3.Bucket).expectCount(1);
 * // Template-compatible (migration path):
 * tree.hasResourceProperties("AWS::S3::Bucket", { VersioningConfiguration: { Status: "Enabled" } });
 */
export class ConstructTree {
  /** Build a tree view + index for `stack`. */
  public static fromStack(stack: Stack): ConstructTree {
    return new ConstructTree(stack);
  }

  private readonly _index: ConstructIndex;

  private constructor(public readonly stack: Stack) {
    this._index = new ConstructIndex(stack);
  }

  /** The underlying index (logical id ↔ construct ↔ resolved props). */
  public get index(): ConstructIndex {
    return this._index;
  }

  /** Find every construct of type `T` in the stack. */
  public findByType<T extends IConstruct>(type: Constructor<T>): ConstructQuery<T> {
    const matches = this.stack.node.findAll().filter((c): c is T => c instanceof type);
    return new ConstructQuery<T>(matches, this._index, `findByType(${typeName(type)})`);
  }

  /** Find constructs by exact tree path. */
  public findByPath(path: string): ConstructQuery<IConstruct> {
    const matches = this.stack.node.findAll().filter((c) => c.node.path === path);
    return new ConstructQuery<IConstruct>(matches, this._index, `findByPath(${path})`);
  }

  /** Find constructs by their scope-local id. */
  public findById(id: string): ConstructQuery<IConstruct> {
    const matches = this.stack.node.findAll().filter((c) => c.node.id === id);
    return new ConstructQuery<IConstruct>(matches, this._index, `findById(${id})`);
  }

  // ── `assertions.Template`-compatible API (migration path) ──────────
  //
  // Thin delegations to the `Template` wrapped by the index. Signatures match
  // `aws-cdk-lib/assertions` exactly so existing tests keep working unchanged.
  // Resource assertions additionally append the construct tree paths of the
  // candidate resources to failure messages (errors are path-centric here).

  /** The resolved CloudFormation template as JSON. Compatible with `Template.toJSON`. */
  public toJSON(): { [key: string]: any } {
    return this._index.templateJson;
  }

  /** Compatible with `Template.templateMatches`. */
  public templateMatches(expected: any): void {
    this.template.templateMatches(expected);
  }

  /** Compatible with `Template.resourceCountIs`. */
  public resourceCountIs(type: string, count: number): void {
    this.withPathHint(type, () => this.template.resourceCountIs(type, count));
  }

  /** Compatible with `Template.resourcePropertiesCountIs`. */
  public resourcePropertiesCountIs(type: string, props: any, count: number): void {
    this.withPathHint(type, () => this.template.resourcePropertiesCountIs(type, props, count));
  }

  /** Compatible with `Template.hasResource`. */
  public hasResource(type: string, props: any): void {
    this.withPathHint(type, () => this.template.hasResource(type, props));
  }

  /** Compatible with `Template.hasResourceProperties`. */
  public hasResourceProperties(type: string, props: any): void {
    this.withPathHint(type, () => this.template.hasResourceProperties(type, props));
  }

  /** Compatible with `Template.allResources`. */
  public allResources(type: string, props: any): void {
    this.withPathHint(type, () => this.template.allResources(type, props));
  }

  /** Compatible with `Template.allResourcesProperties`. */
  public allResourcesProperties(type: string, props: any): void {
    this.withPathHint(type, () => this.template.allResourcesProperties(type, props));
  }

  /** Compatible with `Template.findResources`. */
  public findResources(type: string, props?: any): { [key: string]: { [key: string]: any } } {
    return this.template.findResources(type, props);
  }

  /** Compatible with `Template.hasParameter`. */
  public hasParameter(logicalId: string, props: any): void {
    this.template.hasParameter(logicalId, props);
  }

  /** Compatible with `Template.findParameters`. */
  public findParameters(logicalId: string, props?: any): { [key: string]: { [key: string]: any } } {
    return this.template.findParameters(logicalId, props);
  }

  /** Compatible with `Template.hasOutput`. */
  public hasOutput(logicalId: string, props: any): void {
    this.template.hasOutput(logicalId, props);
  }

  /** Compatible with `Template.findOutputs`. */
  public findOutputs(logicalId: string, props?: any): { [key: string]: { [key: string]: any } } {
    return this.template.findOutputs(logicalId, props);
  }

  /** Compatible with `Template.hasMapping`. */
  public hasMapping(logicalId: string, props: any): void {
    this.template.hasMapping(logicalId, props);
  }

  /** Compatible with `Template.findMappings`. */
  public findMappings(logicalId: string, props?: any): { [key: string]: { [key: string]: any } } {
    return this.template.findMappings(logicalId, props);
  }

  /** Compatible with `Template.hasCondition`. */
  public hasCondition(logicalId: string, props: any): void {
    this.template.hasCondition(logicalId, props);
  }

  /** Compatible with `Template.findConditions`. */
  public findConditions(logicalId: string, props?: any): { [key: string]: { [key: string]: any } } {
    return this.template.findConditions(logicalId, props);
  }

  private get template(): Template {
    return this._index.template;
  }

  /** Re-throw a `Template` assertion failure with the candidates' tree paths appended. */
  private withPathHint(type: string, assertion: () => void): void {
    try {
      assertion();
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      const resources: { [key: string]: any } = this._index.templateJson.Resources ?? {};
      const paths = Object.entries(resources)
        .filter(([, res]) => res?.Type === type)
        .map(([logicalId]) => {
          const path = this._index.constructOf(logicalId)?.node.path;
          return `  - ${logicalId}${path ? ` (${path})` : ""}`;
        });
      if (paths.length === 0) throw e;
      throw new Error(
        `${e.message}\nResources of type ${type} in this stack:\n${paths.join("\n")}`,
      );
    }
  }
}

function typeName(type: Constructor<any>): string {
  return (type as { name?: string }).name ?? "anonymous";
}
