import type { ConstructTree } from "../construct-tree.ts";
import type { ConstructIndex } from "../private/index-model.ts";
import { referencesAnyLogicalId } from "../private/intrinsics.ts";
import { toConstruct, type SubjectOrConstruct } from "./util.ts";

/**
 * Start a type-safe encryption-key wiring assertion:
 *
 * @example
 * expectEncryption(tree).of(bucket).withKey(key);
 */
export function expectEncryption(tree: ConstructTree): EncryptionAssertion {
  return new EncryptionAssertion(tree.index);
}

/**
 * Asserts that a resource is encrypted with a specific KMS key, by checking
 * that some resource under it references the key (via `Ref`/`Fn::GetAtt`) —
 * regardless of the service-specific property name (`KMSMasterKeyID`,
 * `KmsMasterKeyId`, `KmsKeyId`, …).
 *
 * The named intent (`of(bucket).withKey(key)`) is what a reviewer reads,
 * instead of decoding a `BucketEncryption.ServerSideEncryptionConfiguration`
 * block by hand.
 */
export class EncryptionAssertion {
  private _resource?: ReturnType<typeof toConstruct>;

  constructor(private readonly index: ConstructIndex) {}

  /** The resource expected to be encrypted. */
  public of(resource: SubjectOrConstruct): this {
    this._resource = toConstruct(resource);
    return this;
  }

  /** The KMS key it must be encrypted with. Performs the assertion. */
  public withKey(key: SubjectOrConstruct): void {
    if (!this._resource) {
      throw new Error("expectEncryption: of() must be called before withKey()");
    }

    const keyConstruct = toConstruct(key);
    const keyIds = this.index.logicalIdsUnder(keyConstruct);

    const encrypted = this.index
      .cfnResourcesUnder(this._resource)
      .some((cfn) => referencesAnyLogicalId(this.index.resolvedPropertiesOf(cfn), keyIds));

    if (!encrypted) {
      throw new Error(
        `Expected ${this._resource.node.path} to be encrypted with ${keyConstruct.node.path}, ` +
          "but no reference to the key was found in its resources",
      );
    }
  }
}
