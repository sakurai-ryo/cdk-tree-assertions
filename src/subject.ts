import { CfnResource, type RemovalPolicy } from "aws-cdk-lib";
import type { IConstruct } from "constructs";
import { L1Subject } from "./l1-subject.ts";
import type { ConstructIndex } from "./private/index-model.ts";
import { referencesAnyLogicalId } from "./private/intrinsics.ts";
import type { CfnConstructor, Constructor } from "./private/types.ts";
import { ConstructQuery } from "./query.ts";

/**
 * A single construct selected from the tree, type `T`, with assertions that
 * operate on the construct itself, its L1 resources, and its wiring to others.
 */
export class ConstructSubject<T extends IConstruct> {
  constructor(
    /** The real construct instance — the fully-typed escape hatch. */
    public readonly actual: T,
    private readonly index: ConstructIndex,
  ) {}

  /** Path of this construct in the tree. */
  public get path(): string {
    return this.actual.node.path;
  }

  /** Run an arbitrary, fully-typed assertion against the construct instance. */
  public satisfies(fn: (construct: T) => void): this {
    fn(this.actual);
    return this;
  }

  /**
   * Assert an L2 public property by name (checked against `keyof T`) using a
   * predicate over its value (typed as `T[K]`).
   */
  public expectProperty<K extends keyof T>(key: K, predicate: (value: T[K]) => boolean): this {
    const value = this.actual[key];
    if (!predicate(value)) {
      throw new Error(
        `Expected property '${String(key)}' of ${this.path} to satisfy the predicate, ` +
          `but got ${stringify(value)}`,
      );
    }
    return this;
  }

  // ── tree navigation ────────────────────────────────────────────────

  /** The parent construct as a subject. */
  public parent(): ConstructSubject<IConstruct> {
    const scope = this.actual.node.scope;
    if (!scope) {
      throw new Error(`${this.path} has no parent`);
    }
    return new ConstructSubject(scope, this.index);
  }

  /** A direct child by id, as a subject. */
  public child(id: string): ConstructSubject<IConstruct> {
    const c = this.actual.node.tryFindChild(id);
    if (!c) {
      throw new Error(`${this.path} has no child with id '${id}'`);
    }
    return new ConstructSubject(c, this.index);
  }

  /** Search the subtree rooted at this construct by type. */
  public findByType<U extends IConstruct>(type: Constructor<U>): ConstructQuery<U> {
    const matches = this.actual.node.findAll().filter((c): c is U => c instanceof type);
    return new ConstructQuery<U>(
      matches,
      this.index,
      `${this.path} » findByType(${typeName(type)})`,
    );
  }

  // ── descend to L1 ──────────────────────────────────────────────────

  /**
   * The construct's default child as an L1 subject, type-checked against the
   * given `Cfn*` class. `P` (the CFN props struct) is inferred from the class.
   */
  public defaultResource<C extends CfnResource, P>(type: CfnConstructor<C, P>): L1Subject<C, P> {
    const def = this.actual.node.defaultChild;
    if (!def) {
      throw new Error(`${this.path} has no default child resource`);
    }
    if (!(def instanceof (type as unknown as Constructor<C>))) {
      throw new Error(
        `Default child of ${this.path} is not a ${typeName(type)} ` +
          `(was ${def.constructor.name})`,
      );
    }
    return new L1Subject<C, P>(def, this.index);
  }

  /** A specific L1 child by type (and optionally id) as an L1 subject. */
  public resource<C extends CfnResource, P>(
    type: CfnConstructor<C, P>,
    id?: string,
  ): L1Subject<C, P> {
    const candidates = this.actual.node
      .findAll()
      .filter(
        (c): c is C =>
          c instanceof (type as unknown as Constructor<C>) &&
          (id === undefined || c.node.id === id),
      );
    if (candidates.length === 0) {
      throw new Error(`${this.path} has no ${typeName(type)}${id ? ` with id '${id}'` : ""}`);
    }
    if (candidates.length > 1) {
      throw new Error(
        `${this.path} has ${candidates.length} ${typeName(type)} resources; ` +
          "disambiguate with an id",
      );
    }
    return new L1Subject<C, P>(candidates[0], this.index);
  }

  /**
   * Assert the construct's `RemovalPolicy` via its default child resource's CFN
   * `DeletionPolicy`. Convenience for `defaultResource(...).hasRemovalPolicy(...)`
   * that does not require naming the `Cfn*` class.
   */
  public hasRemovalPolicy(policy: RemovalPolicy): this {
    const def = this.actual.node.defaultChild;
    if (!def || !CfnResource.isCfnResource(def)) {
      throw new Error(`${this.path} has no default child resource to read a removal policy from`);
    }
    new L1Subject(def, this.index).hasRemovalPolicy(policy);
    return this;
  }

  // ── wiring ─────────────────────────────────────────────────────────

  /**
   * Assert that some resource under this construct declares a CloudFormation
   * `DependsOn` on a resource under `target`.
   */
  public dependsOn(target: ConstructSubject<any>): this {
    const targetIds = this.index.logicalIdsUnder(target.actual);
    for (const cfn of this.index.cfnResourcesUnder(this.actual)) {
      const dependsOn = this.index.resolvedResourceOf(cfn).DependsOn;
      const declared = Array.isArray(dependsOn) ? dependsOn : dependsOn ? [dependsOn] : [];
      if (declared.some((id: string) => targetIds.has(id))) {
        return this;
      }
    }
    throw new Error(
      `Expected ${this.path} to depend on ${target.path}, but no DependsOn was found`,
    );
  }

  /**
   * Assert that some resource under this construct references a resource under
   * `target` through a `Ref` or `Fn::GetAtt`.
   */
  public references(target: ConstructSubject<any>): this {
    const targetIds = this.index.logicalIdsUnder(target.actual);
    for (const cfn of this.index.cfnResourcesUnder(this.actual)) {
      if (referencesAnyLogicalId(this.index.resolvedPropertiesOf(cfn), targetIds)) {
        return this;
      }
    }
    throw new Error(
      `Expected ${this.path} to reference ${target.path}, but no reference was found`,
    );
  }

  /** Inverse of {@link references}. */
  public referencedBy(source: ConstructSubject<any>): this {
    source.references(this);
    return this;
  }
}

function typeName(type: Constructor<any> | CfnConstructor<any, any>): string {
  return (type as { name?: string }).name ?? "anonymous";
}

function stringify(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable value]";
  }
}
