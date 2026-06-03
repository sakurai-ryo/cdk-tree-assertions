import type { Stack } from "aws-cdk-lib";
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
 * @example
 * const tree = ConstructTree.fromStack(stack);
 * tree.findByType(s3.Bucket).expectCount(1);
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
}

function typeName(type: Constructor<any>): string {
  return (type as { name?: string }).name ?? "anonymous";
}
