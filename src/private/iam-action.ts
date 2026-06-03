import type { ExactIamAction, IamService } from "./iam-actions.generated.ts";

export type { ExactIamAction, IamService };

/**
 * A wildcard IAM action accepted by `can()`: the global `"*"`, or any pattern
 * scoped to a known service prefix ending in `*` (e.g. `"s3:*"`, `"s3:Get*"`).
 *
 * `` `${IamService}:${string}*` `` deliberately permits partial wildcards but
 * only for services AWS actually defines, so `"notaservice:*"` is still caught.
 */
export type IamWildcard = "*" | `${IamService}:${string}*`;

/**
 * An IAM action string for `expectGrant(...).can(...)`. Either an exact
 * `service:Action` from the AWS Service Reference (typos are type errors) or a
 * known-service wildcard ({@link IamWildcard}).
 */
export type IamAction = ExactIamAction | IamWildcard;
