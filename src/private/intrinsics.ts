/**
 * Helpers for inspecting resolved CloudFormation intrinsics.
 *
 * After synthesis, references between resources survive as `{ Ref: id }` or
 * `{ "Fn::GetAtt": [id, attr] }` (possibly nested inside `Fn::Join`/`Fn::Sub`).
 * Wiring assertions work by scanning for these and mapping the logical ids back
 * to typed constructs via the {@link ConstructIndex}.
 */

/**
 * Whether `obj` (anywhere in its structure) references one of `logicalIds`
 * through a `Ref` or `Fn::GetAtt` intrinsic.
 */
export function referencesAnyLogicalId(obj: any, logicalIds: Set<string>): boolean {
  return collectReferencedLogicalIds(obj).some((id) => logicalIds.has(id));
}

/**
 * Whether `value` identifies one of `logicalIds`, either as a bare logical-id
 * string (e.g. an inline rule's implicit group) or through a `Ref`/`Fn::GetAtt`
 * intrinsic.
 */
export function idMatches(value: any, logicalIds: Set<string>): boolean {
  if (typeof value === "string") {
    return logicalIds.has(value);
  }
  return referencesAnyLogicalId(value, logicalIds);
}

/**
 * Every logical id referenced by `obj` via `Ref` or `Fn::GetAtt`, at any depth.
 */
export function collectReferencedLogicalIds(obj: any): string[] {
  const found: string[] = [];
  walk(obj, found);
  return found;
}

function walk(obj: any, found: string[]): void {
  if (obj === null || typeof obj !== "object") {
    return;
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      walk(item, found);
    }
    return;
  }

  const ref = obj.Ref;
  if (typeof ref === "string") {
    found.push(ref);
  }

  const getAtt = obj["Fn::GetAtt"];
  if (Array.isArray(getAtt) && typeof getAtt[0] === "string") {
    found.push(getAtt[0]);
  } else if (typeof getAtt === "string") {
    // GetAtt shorthand "LogicalId.Attribute"
    found.push(getAtt.split(".")[0]);
  }

  for (const key of Object.keys(obj)) {
    walk(obj[key], found);
  }
}

/**
 * IAM action wildcard match.
 *
 * Matches in both directions so a requested `s3:GetObject` is satisfied by a
 * statement action `s3:GetObject*`, and a requested `s3:Get*` is satisfied by a
 * statement action `s3:GetObject`.
 */
export function actionMatches(requested: string, statementAction: string): boolean {
  return wildcardCovers(statementAction, requested) || wildcardCovers(requested, statementAction);
}

/** Whether `pattern` (which may contain `*`/`?`) matches the literal `value`. One-directional. */
export function wildcardCovers(pattern: string, value: string): boolean {
  if (pattern === "*") {
    return true;
  }
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(value);
}
