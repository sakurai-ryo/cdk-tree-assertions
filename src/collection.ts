import { Match } from "aws-cdk-lib/assertions";
import type { PropMatcher } from "./private/types.ts";

/**
 * A view over an **array-valued CloudFormation property** (lifecycle rules,
 * CORS rules, metrics configurations, port mappings, …) with order-independent,
 * predicate-based assertions.
 *
 * Created via {@link L1Subject.collection}. Elements are already token-resolved
 * and in the L1 authoring (camelCase) shape, so predicates and
 * {@link CollectionElementSubject.toMatchProps} read against the element type
 * `E` — replacing brittle `Match.objectLike([...])` index matching.
 */
export class CollectionSubject<E> {
  constructor(
    private readonly elements: E[],
    private readonly description: string,
  ) {}

  /** Number of elements (after any `where` narrowing). */
  public get length(): number {
    return this.elements.length;
  }

  /** Narrow to the elements matching a typed predicate. */
  public where(predicate: (element: E) => boolean): CollectionSubject<E> {
    return new CollectionSubject(this.elements.filter(predicate), `${this.description}.where(...)`);
  }

  // ── count assertions ───────────────────────────────────────────────

  public expectCount(n: number): this {
    if (this.elements.length !== n) {
      throw new Error(
        `Expected ${n} element(s) in ${this.description}, but found ${this.elements.length}`,
      );
    }
    return this;
  }

  public toExist(): this {
    if (this.elements.length === 0) {
      throw new Error(`Expected at least one element in ${this.description}, but found none`);
    }
    return this;
  }

  public toBeEmpty(): this {
    if (this.elements.length !== 0) {
      throw new Error(
        `Expected no elements in ${this.description}, but found ${this.elements.length}`,
      );
    }
    return this;
  }

  // ── content assertions ─────────────────────────────────────────────

  /** At least one element satisfies the predicate. */
  public expectSome(predicate: (element: E) => boolean): this {
    if (!this.elements.some(predicate)) {
      throw new Error(`Expected some element in ${this.description} to satisfy the predicate`);
    }
    return this;
  }

  /** Every element satisfies the predicate. */
  public expectEvery(predicate: (element: E) => boolean): this {
    if (!this.elements.every(predicate)) {
      throw new Error(`Expected every element in ${this.description} to satisfy the predicate`);
    }
    return this;
  }

  /** At least one element matches `expected` (object-like, type-checked against `E`). */
  public expectSomeMatch(expected: PropMatcher<E>): this {
    const matcher = Match.objectLike(expected as { [key: string]: any });
    if (!this.elements.some((e) => matcher.test(e as object).isSuccess)) {
      throw new Error(`Expected some element in ${this.description} to match props, but none did`);
    }
    return this;
  }

  // ── selectors ──────────────────────────────────────────────────────

  /** First element (asserts at least one). */
  public first(): CollectionElementSubject<E> {
    return this.at(0);
  }

  /** Element at `index` (asserts it exists). */
  public at(index: number): CollectionElementSubject<E> {
    if (index < 0 || index >= this.elements.length) {
      throw new Error(
        `No element at index ${index} in ${this.description} (found ${this.elements.length})`,
      );
    }
    return new CollectionElementSubject(this.elements[index], `${this.description}[${index}]`);
  }

  /** Assert exactly one element (after narrowing) and return it. */
  public one(): CollectionElementSubject<E> {
    if (this.elements.length !== 1) {
      throw new Error(
        `Expected exactly one element in ${this.description}, but found ${this.elements.length}`,
      );
    }
    return new CollectionElementSubject(this.elements[0], `${this.description}[0]`);
  }

  /** All elements as subjects. */
  public all(): Array<CollectionElementSubject<E>> {
    return this.elements.map(
      (e, i) => new CollectionElementSubject(e, `${this.description}[${i}]`),
    );
  }
}

/** A single element of a {@link CollectionSubject}. */
export class CollectionElementSubject<E> {
  constructor(
    /** The resolved element value. */
    public readonly value: E,
    private readonly description: string,
  ) {}

  /** Match this element against `expected` (object-like, type-checked against `E`). */
  public toMatchProps(expected: PropMatcher<E>): this {
    const result = Match.objectLike(expected as { [key: string]: any }).test(this.value as object);
    if (!result.isSuccess) {
      throw new Error(
        `Expected ${this.description} to match props, but:\n${result.renderMismatch()}`,
      );
    }
    return this;
  }

  /** Run an arbitrary, fully-typed assertion against the element. */
  public satisfies(fn: (element: E) => void): this {
    fn(this.value);
    return this;
  }
}
