import type { Matcher } from "aws-cdk-lib/assertions";

/**
 * A constructor reference usable as a runtime type token in `findByType` etc.
 *
 * Abstract constructors are allowed so base classes (e.g. `Resource`) can be
 * used as filters.
 */
export type Constructor<T> = abstract new (...args: any[]) => T;

/**
 * A concrete L1 constructor whose third argument is the CFN props struct.
 *
 * Passing a `CfnXxx` class to `defaultResource()` lets TypeScript infer the
 * `CfnXxxProps` type `P`, which is what makes `toMatchProps` type-safe.
 */
export type CfnConstructor<C, P> = new (scope: any, id: string, props: P) => C;

/**
 * Value position in a {@link PropMatcher}.
 *
 * Accepts a literal of the expected type, any `Match.*` matcher, or — for
 * object-valued properties — a nested partial matcher.
 */
export type MatchValue<V> = V | Matcher | (V extends object ? PropMatcher<V> : never);

/**
 * A recursive, partial, type-checked matcher derived from a props struct `P`.
 *
 * Every key is optional (object-like semantics) and every value is checked
 * against the corresponding property type of `P`.
 */
export type PropMatcher<P> = {
  [K in keyof P]?: MatchValue<NonNullable<P[K]>>;
};
