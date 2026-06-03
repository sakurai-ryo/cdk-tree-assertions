import { type CfnResource, RemovalPolicy } from "aws-cdk-lib";
import { Match, Matcher } from "aws-cdk-lib/assertions";
import { CollectionSubject } from "./collection.ts";
import type { ConstructIndex } from "./private/index-model.ts";
import type { PropMatcher } from "./private/types.ts";

/**
 * A single L1 (`Cfn*`) resource, with type-safe assertions against its resolved
 * CloudFormation properties.
 *
 * `P` is the resource's CFN props struct (e.g. `CfnBucketProps`), inferred when
 * the subject is created via {@link ConstructSubject.defaultResource}.
 */
export class L1Subject<C extends CfnResource, P = any> {
  constructor(
    public readonly actual: C,
    private readonly index: ConstructIndex,
  ) {}

  /** Resolved CloudFormation logical id of this resource. */
  public get logicalId(): string {
    return this.index.logicalIdOf(this.actual);
  }

  /**
   * Raw resolved CloudFormation `Properties` of this resource (PascalCase, as
   * emitted to the template). Use {@link toMatchProps} for type-safe matching.
   */
  public get cfnProperties(): { [key: string]: any } {
    return this.index.resolvedPropertiesOf(this.actual);
  }

  /**
   * Assert that the resource's properties match `expected` (object-like — the
   * actual may be a superset).
   *
   * `expected` is written and type-checked in the L1 authoring (camelCase)
   * shape of the resource's `CfnXxxProps`. Each referenced property is read
   * from the L1 instance and token-resolved, so the comparison is exact and
   * casing-correct — no CamelCase/PascalCase translation heuristics. `Match.*`
   * matchers may be used for dynamic positions (tokens, arrays, regex).
   */
  public toMatchProps(expected: PropMatcher<P>): this {
    const actual: { [key: string]: any } = {};
    for (const key of Object.keys(expected as object)) {
      actual[key] = this.index.stack.resolve((this.actual as any)[key]);
    }

    const result = Match.objectLike(expected as { [key: string]: any }).test(actual);
    if (!result.isSuccess) {
      throw new Error(
        `Expected ${describe(this)} to match props, but:\n${result.renderMismatch()}`,
      );
    }
    return this;
  }

  /**
   * Assert that an authoring property is **not set** — the intent behind a
   * conditional `if (...) props.x = ...`. Reads the L1 instance field (like
   * {@link toMatchProps}), so it reflects what the construct authored, not raw
   * `addPropertyOverride` escapes — use {@link expectCfnPathAbsent} for those.
   */
  public expectNoProperty(key: Extract<keyof P, string>): this {
    const value = this.index.stack.resolve((this.actual as any)[key]);
    if (value !== undefined) {
      throw new Error(
        `Expected ${describe(this)} not to set property '${key}', but it resolved to ${stringify(value)}`,
      );
    }
    return this;
  }

  // ── rendered template (post-override) ──────────────────────────────

  /**
   * Assert a value at `path` within the **rendered** CloudFormation `Properties`
   * (PascalCase, with `addPropertyOverride`/`addOverride` already applied) — the
   * one place those escape hatches are observable, which {@link toMatchProps}
   * (instance-field based) cannot see.
   *
   * `path` is a dotted string or an array of keys/indices. `expected` is a
   * literal (exact match) or any `Match.*` matcher.
   *
   * @example
   * l1.expectCfnPath("BucketName", "overridden-name");
   * l1.expectCfnPath(["Tags", 0, "Key"], Match.anyValue());
   */
  public expectCfnPath(path: string | Array<string | number>, expected: unknown): this {
    const segments = normalizePath(path);
    const { found, value } = navigate(this.cfnProperties, segments);
    if (!found) {
      throw new Error(
        `Expected ${describe(this)} to have a rendered property at '${segments.join(".")}', but it was absent`,
      );
    }
    const matcher = Matcher.isMatcher(expected) ? expected : Match.exact(expected);
    const result = matcher.test(value);
    if (!result.isSuccess) {
      throw new Error(
        `Expected ${describe(this)} property '${segments.join(".")}' to match, but:\n${result.renderMismatch()}`,
      );
    }
    return this;
  }

  /**
   * Assert that no value exists at `path` in the rendered `Properties` — e.g.
   * after `addDeletionOverride`, or to confirm a property was never rendered.
   */
  public expectCfnPathAbsent(path: string | Array<string | number>): this {
    const segments = normalizePath(path);
    const { found, value } = navigate(this.cfnProperties, segments);
    if (found && value !== undefined) {
      throw new Error(
        `Expected ${describe(this)} not to have a rendered property at '${segments.join(".")}', ` +
          `but it resolved to ${stringify(value)}`,
      );
    }
    return this;
  }

  // ── CloudFormation resource attributes (not Properties) ────────────

  /**
   * Assert this resource's CloudFormation `DeletionPolicy` (e.g. `"Retain"`,
   * `"Delete"`, `"Snapshot"`) — a top-level attribute, not a property, so it is
   * out of reach of {@link toMatchProps}.
   */
  public hasDeletionPolicy(policy: string): this {
    return this.expectAttribute("DeletionPolicy", policy);
  }

  /** Assert this resource's CloudFormation `UpdateReplacePolicy`. */
  public hasUpdateReplacePolicy(policy: string): this {
    return this.expectAttribute("UpdateReplacePolicy", policy);
  }

  /**
   * Assert the construct's `RemovalPolicy` by checking the resulting CFN
   * `DeletionPolicy` (and, for `RETAIN`, `UpdateReplacePolicy`) — so tests read
   * `hasRemovalPolicy(RemovalPolicy.RETAIN)` instead of a logical-id-bound
   * `templateMatches({ MyBucketF68F3FF0: { DeletionPolicy: "Retain" } })`.
   */
  public hasRemovalPolicy(policy: RemovalPolicy): this {
    const expected = REMOVAL_POLICY_TO_DELETION_POLICY[policy];
    this.expectAttribute("DeletionPolicy", expected);
    if (policy === RemovalPolicy.RETAIN) {
      this.expectAttribute("UpdateReplacePolicy", expected);
    }
    return this;
  }

  /**
   * A view over an array-valued property for order-independent, predicate-based
   * assertions. `select` is:
   *
   *  - a property key (top-level array, e.g. `"metricsConfigurations"`), or
   *  - a path of keys for nested arrays (e.g. `["lifecycleConfiguration", "rules"]`),
   *    resolved step by step so lazily-rendered containers are unwrapped, or
   *  - an accessor returning the array (eager values only).
   *
   * Elements are token-resolved and in the L1 authoring (camelCase) shape.
   *
   * @example
   * bucket.collection<s3.CfnBucket.MetricsConfigurationProperty>("metricsConfigurations")
   *   .where(m => m.id === "EntireBucket").expectCount(1);
   */
  public collection<E = any>(
    select: string | string[] | ((resource: C) => unknown),
    label?: string,
  ): CollectionSubject<E> {
    let raw: unknown;
    if (typeof select === "function") {
      raw = this.index.stack.resolve(select(this.actual));
    } else {
      // Resolve at each step so lazily-rendered containers (tokens) are unwrapped.
      const path = Array.isArray(select) ? select : [select];
      raw = this.actual;
      for (const key of path) {
        raw = this.index.stack.resolve((raw as { [k: string]: unknown } | undefined)?.[key]);
      }
    }
    const elements: E[] =
      raw === undefined || raw === null ? [] : Array.isArray(raw) ? (raw as E[]) : [raw as E];
    const name =
      label ??
      (Array.isArray(select)
        ? select.join(".")
        : typeof select === "string"
          ? select
          : "collection");
    return new CollectionSubject<E>(elements, `${this.actual.node.path}.${name}`);
  }

  /** Run an arbitrary, fully-typed assertion against the L1 resource instance. */
  public satisfies(fn: (resource: C) => void): this {
    fn(this.actual);
    return this;
  }

  private expectAttribute(name: string, expected: string): this {
    const actual = this.index.resolvedResourceOf(this.actual)[name];
    if (actual !== expected) {
      throw new Error(
        `Expected ${describe(this)} to have ${name} '${expected}', but got ${
          actual === undefined ? "no such attribute" : `'${actual}'`
        }`,
      );
    }
    return this;
  }
}

const REMOVAL_POLICY_TO_DELETION_POLICY: Record<RemovalPolicy, string> = {
  [RemovalPolicy.DESTROY]: "Delete",
  [RemovalPolicy.RETAIN]: "Retain",
  [RemovalPolicy.SNAPSHOT]: "Snapshot",
  [RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE]: "RetainExceptOnCreate",
};

function describe(subject: L1Subject<any, any>): string {
  return `${subject.actual.node.path} (${subject.actual.cfnResourceType}, logicalId=${subject.logicalId})`;
}

function normalizePath(path: string | Array<string | number>): Array<string | number> {
  return Array.isArray(path) ? path : path.split(".");
}

/** Walk `segments` into `root`, reporting whether the full path resolved. */
function navigate(
  root: { [key: string]: any },
  segments: Array<string | number>,
): { found: boolean; value: any } {
  let current: any = root;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== "object") {
      return { found: false, value: undefined };
    }
    if (!(segment in current)) {
      return { found: false, value: undefined };
    }
    current = current[segment];
  }
  return { found: true, value: current };
}

function stringify(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable value]";
  }
}
