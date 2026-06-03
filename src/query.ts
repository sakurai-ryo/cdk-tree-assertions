import type { IConstruct } from "constructs";
import type { ConstructIndex } from "./private/index-model.ts";
import type { Constructor } from "./private/types.ts";
import { ConstructSubject } from "./subject.ts";

/**
 * A (possibly empty) set of constructs of type `T` matched against the tree.
 *
 * Count assertions return `this` for chaining; selectors (`one`, `first`,
 * `at`, `all`) narrow to {@link ConstructSubject}s.
 */
export class ConstructQuery<T extends IConstruct> {
  constructor(
    private readonly matches: T[],
    private readonly index: ConstructIndex,
    private readonly description: string,
  ) {}

  /** Number of matched constructs. */
  public get length(): number {
    return this.matches.length;
  }

  /** Narrow the matches with a typed predicate. */
  public where(predicate: (construct: T) => boolean): ConstructQuery<T> {
    return new ConstructQuery(
      this.matches.filter(predicate),
      this.index,
      `${this.description}.where(...)`,
    );
  }

  /** Narrow the matches further by a (sub)type. */
  public filterByType<U extends T>(type: Constructor<U>): ConstructQuery<U> {
    const narrowed = this.matches.filter((c): c is U => c instanceof type);
    return new ConstructQuery<U>(narrowed, this.index, `${this.description}.filterByType(...)`);
  }

  // ── count assertions ───────────────────────────────────────────────

  public expectCount(n: number): this {
    if (this.matches.length !== n) {
      throw new Error(
        `Expected ${n} construct(s) for ${this.description}, but found ${this.matches.length}` +
          this.renderPaths(),
      );
    }
    return this;
  }

  public toExist(): this {
    if (this.matches.length === 0) {
      throw new Error(`Expected at least one construct for ${this.description}, but found none`);
    }
    return this;
  }

  public toBeEmpty(): this {
    if (this.matches.length !== 0) {
      throw new Error(
        `Expected no constructs for ${this.description}, but found ${this.matches.length}` +
          this.renderPaths(),
      );
    }
    return this;
  }

  // ── selectors ──────────────────────────────────────────────────────

  /** Assert exactly one match and return it. */
  public one(): ConstructSubject<T> {
    if (this.matches.length !== 1) {
      throw new Error(
        `Expected exactly one construct for ${this.description}, but found ${this.matches.length}` +
          this.renderPaths(),
      );
    }
    return new ConstructSubject(this.matches[0], this.index);
  }

  /** First match (asserts at least one). */
  public first(): ConstructSubject<T> {
    return this.at(0);
  }

  /** Match at `index` (asserts it exists). */
  public at(index: number): ConstructSubject<T> {
    const match = this.matches[index];
    if (!match) {
      throw new Error(
        `No construct at index ${index} for ${this.description} (found ${this.matches.length})`,
      );
    }
    return new ConstructSubject(match, this.index);
  }

  /** All matches as subjects. */
  public all(): Array<ConstructSubject<T>> {
    return this.matches.map((m) => new ConstructSubject(m, this.index));
  }

  /** Run an assertion against every matched subject. */
  public forEach(fn: (subject: ConstructSubject<T>) => void): this {
    this.all().forEach(fn);
    return this;
  }

  private renderPaths(): string {
    if (this.matches.length === 0) {
      return "";
    }
    return `:\n${this.matches.map((m) => `  - ${m.node.path}`).join("\n")}`;
  }
}
