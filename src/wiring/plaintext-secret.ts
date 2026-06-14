import type { ConstructTree } from "../construct-tree.ts";
import type { ConstructIndex } from "../private/index-model.ts";
import { toConstruct, type SubjectOrConstruct } from "./util.ts";

/**
 * Assert that no environment variable under a construct carries a plaintext
 * secret:
 *
 * @example
 * expectNoPlaintextSecret(tree).of(fn);
 * expectNoPlaintextSecret(tree).allowingKeys("API_KEY_PARAM_NAME").of(fn);
 *
 * Scanned containers: Lambda `Environment.Variables`, ECS task definition
 * container `Environment` entries, and CodeBuild `EnvironmentVariables` of
 * type `PLAINTEXT`. A value is flagged when
 *
 *  - it matches a known credential format (AWS access key id, PEM private
 *    key, GitHub/Slack token) regardless of its name, or
 *  - its name suggests a secret (`*_PASSWORD`, `*_TOKEN`, `*_API_KEY`, …) and
 *    the value is a non-trivial string literal.
 *
 * Unresolved intrinsics and `{{resolve:secretsmanager|ssm-secure:…}}` dynamic
 * references are always safe: referencing a secret is exactly the reviewed
 * behavior. Failure messages never print the offending value.
 */
export function expectNoPlaintextSecret(tree: ConstructTree): PlaintextSecretAssertion {
  return new PlaintextSecretAssertion(tree.index);
}

export class PlaintextSecretAssertion {
  private readonly _allowedKeys = new Set<string>();

  constructor(private readonly index: ConstructIndex) {}

  /** Exempt variable names that are false positives (e.g. `API_KEY_PARAM_NAME`). */
  public allowingKeys(...keys: string[]): this {
    for (const key of keys) {
      this._allowedKeys.add(key);
    }
    return this;
  }

  /** The construct (and its whole subtree) to inspect. Performs the assertion. */
  public of(target: SubjectOrConstruct): void {
    const construct = toConstruct(target);
    const findings: string[] = [];

    for (const cfn of this.index.cfnResourcesUnder(construct)) {
      const props = this.index.resolvedPropertiesOf(cfn);
      for (const { key, value } of environmentEntriesOf(cfn.cfnResourceType, props)) {
        const reason = this.violationOf(key, value);
        if (reason) {
          findings.push(`  - ${cfn.node.path}: environment variable '${key}' ${reason}`);
        }
      }
    }

    if (findings.length > 0) {
      throw new Error(
        `Expected no plaintext secret under ${construct.node.path}, but found:\n` +
          `${findings.join("\n")}\n` +
          "(values are not printed; reference a secret via Secrets Manager / SSM SecureString " +
          "instead, or exempt a false positive with .allowingKeys(...))",
      );
    }
  }

  private violationOf(key: string, value: unknown): string | undefined {
    if (this._allowedKeys.has(key) || typeof value !== "string") {
      return undefined; // non-strings are unresolved intrinsics (Ref/GetAtt/…)
    }
    if (value.includes("{{resolve:")) {
      return undefined; // dynamic reference — resolved at deploy time, never in the template
    }
    if (CREDENTIAL_VALUE_PATTERNS.some((p) => p.test(value))) {
      return "matches a known credential format";
    }
    if (SECRET_KEY_PATTERN.test(key) && !isTrivialValue(value)) {
      return "is named like a secret but holds a string literal";
    }
    return undefined;
  }
}

const SECRET_KEY_PATTERN =
  /(secret|password|passwd|pwd|token|api[-_]?key|access[-_]?key|private[-_]?key|credential)/i;

const CREDENTIAL_VALUE_PATTERNS = [
  /^AKIA[0-9A-Z]{16}$/, // AWS access key id
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, // PEM private key
  /^ghp_[A-Za-z0-9]{30,}$/, // GitHub personal access token
  /^xox[baprs]-[A-Za-z0-9-]+$/, // Slack token
];

/** Short flag-like values ("true", "0", "disabled") are not secrets. */
function isTrivialValue(value: string): boolean {
  return value.length < 8;
}

function environmentEntriesOf(
  resourceType: string,
  props: { [key: string]: any },
): Array<{ key: string; value: unknown }> {
  switch (resourceType) {
    case "AWS::Lambda::Function": {
      const variables = props.Environment?.Variables ?? {};
      return Object.entries(variables).map(([key, value]) => ({ key, value }));
    }
    case "AWS::ECS::TaskDefinition": {
      const entries: Array<{ key: string; value: unknown }> = [];
      for (const container of props.ContainerDefinitions ?? []) {
        for (const entry of container.Environment ?? []) {
          if (typeof entry?.Name === "string") {
            entries.push({ key: entry.Name, value: entry.Value });
          }
        }
      }
      return entries;
    }
    case "AWS::CodeBuild::Project": {
      const entries: Array<{ key: string; value: unknown }> = [];
      for (const entry of props.Environment?.EnvironmentVariables ?? []) {
        const isPlaintext = entry?.Type === undefined || entry.Type === "PLAINTEXT";
        if (isPlaintext && typeof entry?.Name === "string") {
          entries.push({ key: entry.Name, value: entry.Value });
        }
      }
      return entries;
    }
    default:
      return [];
  }
}
