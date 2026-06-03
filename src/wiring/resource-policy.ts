import type { ConstructTree } from "../construct-tree.ts";
import type { ConstructIndex } from "../private/index-model.ts";
import { actionMatches, referencesAnyLogicalId } from "../private/intrinsics.ts";
import { toConstruct, type SubjectOrConstruct } from "./util.ts";

/**
 * Start a type-safe **resource-side** policy assertion — the mirror image of
 * `expectGrant`, which only sees the *principal's* IAM policies.
 *
 * @example
 * expectResourcePolicy(tree).of(bucket).allows({ service: "logs.amazonaws.com" }).to("s3:PutObject");
 * expectResourcePolicy(tree).of(key).hasNoStatement({ effect: "Allow", principal: "*" });
 */
export function expectResourcePolicy(tree: ConstructTree): ResourcePolicyAssertion {
  return new ResourcePolicyAssertion(tree.index);
}

/**
 * Start a type-safe **bucket policy** assertion: a {@link ResourcePolicyAssertion}
 * with S3 security-intent shortcuts (`deniesInsecureTransport`, `deniesTlsBelow`).
 *
 * @example
 * expectBucketPolicy(tree).of(bucket).deniesInsecureTransport().deniesTlsBelow(1.2);
 */
export function expectBucketPolicy(tree: ConstructTree): BucketPolicyAssertion {
  return new BucketPolicyAssertion(tree.index);
}

/** How a statement's `Principal` should match. */
export type PrincipalSpec =
  | "*"
  | { readonly service: string }
  | { readonly aws: string }
  | { readonly construct: SubjectOrConstruct };

/** A single `Condition` operator/key (and optional value) a statement must carry. */
export interface ConditionCriteria {
  readonly operator: string;
  readonly key: string;
  readonly value?: string | number | boolean;
}

/** A statement to look for in a resource-side policy document. */
export interface StatementCriteria {
  readonly effect?: "Allow" | "Deny";
  /** Actions that must all be granted/denied (wildcards allowed, matched both ways). */
  readonly actions?: string | string[];
  readonly principal?: PrincipalSpec;
  readonly conditions?: ConditionCriteria | ConditionCriteria[];
  /** When set, the statement's `Resource` must reference this construct (or be `"*"`). */
  readonly onResource?: SubjectOrConstruct | "*";
}

/**
 * Asserts statements on a resource-side policy (S3 `BucketPolicy`, KMS
 * `KeyPolicy`, SQS/SNS/Secrets resource policies, …), resolving principals and
 * resources back to constructs so logical ids and `Fn::Join` ARNs never appear
 * in the test.
 *
 * v1 scope: existence of a statement matching effect/actions/principal/
 * conditions. `NotAction`/`NotPrincipal` are out of scope.
 */
export class ResourcePolicyAssertion {
  protected _resource?: ReturnType<typeof toConstruct>;

  constructor(protected readonly index: ConstructIndex) {}

  /** The resource whose attached policy is inspected. */
  public of(resource: SubjectOrConstruct): this {
    this._resource = toConstruct(resource);
    return this;
  }

  /** Assert that a matching statement exists. */
  public hasStatement(criteria: StatementCriteria): this {
    const { resource, statements } = this.collect();
    if (!statements.some((s) => statementMatches(s, criteria, this.index))) {
      throw new Error(
        `Expected the resource policy of ${resource.node.path} to contain ${describeCriteria(criteria)}, ` +
          `but no matching statement was found (checked ${statements.length} statement(s))`,
      );
    }
    return this;
  }

  /** Assert that NO matching statement exists (the core "absence" guarantee). */
  public hasNoStatement(criteria: StatementCriteria): this {
    const { resource, statements } = this.collect();
    if (statements.some((s) => statementMatches(s, criteria, this.index))) {
      throw new Error(
        `Expected the resource policy of ${resource.node.path} to contain no ${describeCriteria(criteria)}, ` +
          "but a matching statement was found",
      );
    }
    return this;
  }

  /** Begin an `Allow` statement expectation for `principal`. */
  public allows(principal: PrincipalSpec): StatementChain {
    return new StatementChain(this, { effect: "Allow", principal });
  }

  /** Begin a `Deny` statement expectation for `principal`. */
  public denies(principal: PrincipalSpec): StatementChain {
    return new StatementChain(this, { effect: "Deny", principal });
  }

  private collect(): { resource: ReturnType<typeof toConstruct>; statements: any[] } {
    if (!this._resource) {
      throw new Error("expectResourcePolicy: of() must be called before asserting");
    }
    return { resource: this._resource, statements: this.resourcePolicyStatements(this._resource) };
  }

  /** All statements from policies attached to (or referencing) the target. */
  private resourcePolicyStatements(target: ReturnType<typeof toConstruct>): any[] {
    const targetIds = this.index.logicalIdsUnder(target);
    const out: any[] = [];

    for (const cfn of this.index.cfnResourcesUnder(this.index.stack)) {
      const props = this.index.resolvedPropertiesOf(cfn);
      const id = this.index.logicalIdOf(cfn);

      // Inline policy on a resource under the target (KMS KeyPolicy, etc.).
      if (targetIds.has(id)) {
        out.push(...statementsOf(props.KeyPolicy));
        out.push(...statementsOf(props.PolicyDocument));
      }

      // A dedicated `*Policy` resource (BucketPolicy/QueuePolicy/…) pointing at the target.
      if (
        cfn.cfnResourceType.endsWith("Policy") &&
        props.PolicyDocument &&
        !targetIds.has(id) &&
        referencesAnyLogicalId(props, targetIds)
      ) {
        out.push(...statementsOf(props.PolicyDocument));
      }
    }

    return out;
  }
}

/** A bucket-policy assertion with S3 security-intent shortcuts. */
export class BucketPolicyAssertion extends ResourcePolicyAssertion {
  /** The bucket must deny all access over insecure (non-TLS) transport. */
  public deniesInsecureTransport(): this {
    return this.hasStatement({
      effect: "Deny",
      actions: "s3:*",
      principal: "*",
      conditions: { operator: "Bool", key: "aws:SecureTransport", value: "false" },
    });
  }

  /** The bucket must deny access from TLS versions below `version` (e.g. `1.2`). */
  public deniesTlsBelow(version: number): this {
    return this.hasStatement({
      effect: "Deny",
      conditions: { operator: "NumericLessThan", key: "s3:TlsVersion", value: version },
    });
  }
}

/**
 * A fluent expectation begun by {@link ResourcePolicyAssertion.allows} /
 * `.denies`. Each refining call re-asserts the accumulated criteria, so any
 * intermediate point is itself a valid assertion.
 */
export class StatementChain {
  constructor(
    private readonly parent: ResourcePolicyAssertion,
    private criteria: StatementCriteria,
  ) {
    this.assertNow();
  }

  /** Require these actions (in addition to any already required). */
  public to(...actions: string[]): this {
    const existing = normalizeActions(this.criteria.actions);
    this.criteria = { ...this.criteria, actions: [...existing, ...actions] };
    return this.assertNow();
  }

  /** Require a `Condition` operator/key (and optional value). */
  public where(operator: string, key: string, value?: string | number | boolean): this {
    const existing = normalizeConditions(this.criteria.conditions);
    this.criteria = { ...this.criteria, conditions: [...existing, { operator, key, value }] };
    return this.assertNow();
  }

  /** Require the statement's `Resource` to reference `resource` (or be `"*"`). */
  public on(resource: SubjectOrConstruct | "*"): this {
    this.criteria = { ...this.criteria, onResource: resource };
    return this.assertNow();
  }

  /** Return to the parent assertion to chain another statement. */
  public and(): ResourcePolicyAssertion {
    return this.parent;
  }

  private assertNow(): this {
    this.parent.hasStatement(this.criteria);
    return this;
  }
}

function statementMatches(
  statement: any,
  criteria: StatementCriteria,
  index: ConstructIndex,
): boolean {
  if (criteria.effect !== undefined && statement?.Effect !== criteria.effect) {
    return false;
  }

  const requiredActions = normalizeActions(criteria.actions);
  if (requiredActions.length > 0) {
    const actions = toArray(statement?.Action).filter((a): a is string => typeof a === "string");
    if (!requiredActions.every((req) => actions.some((a) => actionMatches(req, a)))) {
      return false;
    }
  }

  if (
    criteria.principal !== undefined &&
    !principalMatches(statement?.Principal, criteria.principal, index)
  ) {
    return false;
  }

  for (const condition of normalizeConditions(criteria.conditions)) {
    if (!conditionMatches(statement?.Condition, condition)) {
      return false;
    }
  }

  if (
    criteria.onResource !== undefined &&
    !resourceMatches(statement?.Resource, criteria.onResource, index)
  ) {
    return false;
  }

  return true;
}

function principalMatches(principal: any, spec: PrincipalSpec, index: ConstructIndex): boolean {
  if (spec === "*") {
    return principal === "*" || principal?.AWS === "*" || toArray(principal?.AWS).includes("*");
  }
  if ("service" in spec) {
    return toArray(principal?.Service).includes(spec.service);
  }
  if ("aws" in spec) {
    return toArray(principal?.AWS).includes(spec.aws);
  }
  const ids = index.logicalIdsUnder(toConstruct(spec.construct));
  return referencesAnyLogicalId(principal, ids);
}

function conditionMatches(condition: any, criteria: ConditionCriteria): boolean {
  const entry = condition?.[criteria.operator]?.[criteria.key];
  if (entry === undefined) {
    return false;
  }
  if (criteria.value === undefined) {
    return true;
  }
  return toArray(entry).some((v) => String(v) === String(criteria.value));
}

function resourceMatches(
  resource: any,
  target: SubjectOrConstruct | "*",
  index: ConstructIndex,
): boolean {
  const resources = toArray(resource);
  if (target === "*") {
    return resources.includes("*");
  }
  const ids = index.logicalIdsUnder(toConstruct(target));
  return resources.some((r) => r === "*" || referencesAnyLogicalId(r, ids));
}

function statementsOf(policyDocument: any): any[] {
  return toArray(policyDocument?.Statement);
}

function normalizeActions(actions: string | string[] | undefined): string[] {
  if (actions === undefined) return [];
  return Array.isArray(actions) ? actions : [actions];
}

function normalizeConditions(
  conditions: ConditionCriteria | ConditionCriteria[] | undefined,
): ConditionCriteria[] {
  if (conditions === undefined) return [];
  return Array.isArray(conditions) ? conditions : [conditions];
}

function toArray(value: any): any[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function describeCriteria(criteria: StatementCriteria): string {
  const parts: string[] = [];
  if (criteria.effect) parts.push(`Effect=${criteria.effect}`);
  const actions = normalizeActions(criteria.actions);
  if (actions.length) parts.push(`Action=[${actions.join(", ")}]`);
  if (criteria.principal) parts.push(`Principal=${describePrincipal(criteria.principal)}`);
  for (const c of normalizeConditions(criteria.conditions)) {
    parts.push(`Condition ${c.operator}/${c.key}${c.value === undefined ? "" : `=${c.value}`}`);
  }
  if (criteria.onResource !== undefined) {
    parts.push(
      `Resource=${criteria.onResource === "*" ? "*" : toConstruct(criteria.onResource).node.path}`,
    );
  }
  return `a statement { ${parts.join(", ")} }`;
}

function describePrincipal(spec: PrincipalSpec): string {
  if (spec === "*") return "*";
  if ("service" in spec) return `service:${spec.service}`;
  if ("aws" in spec) return `aws:${spec.aws}`;
  return `construct:${toConstruct(spec.construct).node.path}`;
}
