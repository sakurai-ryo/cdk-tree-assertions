import type { ConstructTree } from "../construct-tree.ts";
import type { ConstructIndex } from "../private/index-model.ts";
import { collectReferencedLogicalIds, referencesAnyLogicalId } from "../private/intrinsics.ts";
import { toConstruct, type SubjectOrConstruct } from "./util.ts";

/**
 * Start a type-safe REST API Gateway route assertion — the behavioral intent
 * "this method/path is handled by this function", instead of reading an
 * `AWS::ApiGateway::Method` + walking `AWS::ApiGateway::Resource` parents and
 * decoding the integration `Uri` by hand.
 *
 * @example
 * expectRoute(tree).api(api).method("GET", "/users").to(fn);
 */
export function expectRoute(tree: ConstructTree): RouteAssertion {
  return new RouteAssertion(tree.index, false);
}

/** The negative form: assert the route is NOT wired to the given handler. */
export function expectNoRoute(tree: ConstructTree): RouteAssertion {
  return new RouteAssertion(tree.index, true);
}

/**
 * Asserts that a REST API Gateway route (`method` + `path`) integrates a Lambda
 * function. The path is reconstructed from the `Resource` `ParentId` chain (root
 * = `RootResourceId`) and the handler is matched by intrinsic reference inside
 * the method's `Integration.Uri` — so neither logical ids nor the `Fn::Join`
 * ARN appear in the test.
 *
 * REST API only (`AWS::ApiGateway::*`); HTTP API (`apigatewayv2`) is future work.
 */
export class RouteAssertion {
  private _api?: ReturnType<typeof toConstruct>;
  private _method?: string;
  private _path?: string;

  constructor(
    private readonly index: ConstructIndex,
    private readonly negate: boolean,
  ) {}

  /** The REST API the route belongs to. */
  public api(api: SubjectOrConstruct): this {
    this._api = toConstruct(api);
    return this;
  }

  /** The HTTP method and path, e.g. `("GET", "/users")`. */
  public method(httpMethod: string, path: string): this {
    this._method = httpMethod;
    this._path = path;
    return this;
  }

  /** The Lambda function the route must (not) integrate. Performs the assertion. */
  public to(fn: SubjectOrConstruct): void {
    if (!this._api) {
      throw new Error("expectRoute: api() must be called before to()");
    }
    if (this._method === undefined || this._path === undefined) {
      throw new Error("expectRoute: method() must be called before to()");
    }

    const fnConstruct = toConstruct(fn);
    const fnIds = this.index.logicalIdsUnder(fnConstruct);
    const wantMethod = this._method.toUpperCase();
    const wantPath = normalizePath(this._path);
    const resourcesById = this.resourcesUnderApi();

    const found = this.methodsUnderApi().some((m) => {
      if (typeof m.HttpMethod !== "string" || m.HttpMethod.toUpperCase() !== wantMethod) {
        return false;
      }
      if (resourcePath(m.ResourceId, resourcesById) !== wantPath) {
        return false;
      }
      return referencesAnyLogicalId(m.Integration?.Uri, fnIds);
    });

    if (found === this.negate) {
      const apiPath = this._api.node.path;
      const fnPath = fnConstruct.node.path;
      const route = `${wantMethod} ${wantPath}`;
      throw new Error(
        this.negate
          ? `Expected ${apiPath} not to route ${route} to ${fnPath}, but a matching integration was found`
          : `Expected ${apiPath} to route ${route} to ${fnPath}, but no matching method/integration was found`,
      );
    }
  }

  private methodsUnderApi(): Array<{ HttpMethod?: any; ResourceId?: any; Integration?: any }> {
    return this.index
      .cfnResourcesUnder(this._api!)
      .filter((cfn) => cfn.cfnResourceType === "AWS::ApiGateway::Method")
      .map((cfn) => this.index.resolvedPropertiesOf(cfn));
  }

  /** Map of logical id → resolved props for every `AWS::ApiGateway::Resource`. */
  private resourcesUnderApi(): Map<string, { PathPart?: any; ParentId?: any }> {
    const map = new Map<string, { PathPart?: any; ParentId?: any }>();
    for (const cfn of this.index.cfnResourcesUnder(this._api!)) {
      if (cfn.cfnResourceType === "AWS::ApiGateway::Resource") {
        map.set(this.index.logicalIdOf(cfn), this.index.resolvedPropertiesOf(cfn));
      }
    }
    return map;
  }
}

/** Normalize a user-supplied path to a leading slash and no trailing slash. */
function normalizePath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeading === "" ? "/" : withLeading;
}

/** Reconstruct the resource path from a `ResourceId` intrinsic, or `undefined`. */
function resourcePath(
  resourceId: any,
  resourcesById: Map<string, { PathPart?: any; ParentId?: any }>,
): string | undefined {
  if (isRootRef(resourceId)) {
    return "/";
  }
  const id = singleReferencedId(resourceId);
  if (id === undefined) {
    return undefined;
  }
  const resource = resourcesById.get(id);
  if (!resource || typeof resource.PathPart !== "string") {
    return undefined;
  }
  const parent = resourcePath(resource.ParentId, resourcesById);
  if (parent === undefined) {
    return undefined;
  }
  return parent === "/" ? `/${resource.PathPart}` : `${parent}/${resource.PathPart}`;
}

/** Whether an intrinsic is `{ "Fn::GetAtt": [_, "RootResourceId"] }`. */
function isRootRef(intrinsic: any): boolean {
  const getAtt = intrinsic?.["Fn::GetAtt"];
  if (Array.isArray(getAtt)) {
    return getAtt[1] === "RootResourceId";
  }
  if (typeof getAtt === "string") {
    return getAtt.split(".")[1] === "RootResourceId";
  }
  return false;
}

/** The single logical id referenced by a `Ref`/`Fn::GetAtt` intrinsic. */
function singleReferencedId(intrinsic: any): string | undefined {
  return collectReferencedLogicalIds(intrinsic)[0];
}
