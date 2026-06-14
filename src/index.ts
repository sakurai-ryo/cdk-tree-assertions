export * from "./construct-tree.ts";
export * from "./query.ts";
export * from "./subject.ts";
export * from "./l1-subject.ts";
export * from "./collection.ts";
export * from "./wiring/grant.ts";
export * from "./wiring/connection.ts";
export * from "./wiring/encryption.ts";
export * from "./wiring/resource-policy.ts";
export * from "./wiring/event-source.ts";
export * from "./wiring/schedule.ts";
export * from "./wiring/route.ts";
export * from "./wiring/flow.ts";
export * from "./wiring/no-wildcard.ts";
export * from "./wiring/public-access.ts";
export * from "./wiring/plaintext-secret.ts";

// Re-exported for the `assertions.Template` migration path: existing tests can
// switch their `Match` import here without touching the assertions themselves.
export { Match, Matcher } from "aws-cdk-lib/assertions";

export { ConstructIndex } from "./private/index-model.ts";
export type { IamAction, IamService, ExactIamAction } from "./private/iam-action.ts";
export type { SubjectOrConstruct } from "./wiring/util.ts";
export type { PropMatcher, MatchValue, Constructor, CfnConstructor } from "./private/types.ts";
