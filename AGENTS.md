# AGENTS.md — cdk-tree-assertions

> Guide for AI agents working on this repo. Read this before editing.

## What this library is

**Intent-level, reviewable assertions for the AWS CDK Construct tree.** Type
safety is the _mechanism_, not the headline. The thesis: as AI writes more
tests, the bottleneck shifts from _writing_ to _reviewing_ — so assertions
should read as intent (`expectGrant(fn).can("s3:GetObject").on(bucket)`) rather
than as hand-traced CloudFormation JSON.

**TypeScript-only by design.** It deliberately relies on generics and mapped
types and is **not** jsii-compatible. Never add multi-language / jsii concerns.

## Architecture (the mental model)

- **`ConstructIndex` (`src/private/index-model.ts`) is the cornerstone.** It
  bridges three views of one stack: typed construct instances ↔ CloudFormation
  logical ids ↔ resolved CFN properties. Every assertion is a thin layer on top.
- **Token resolution is NOT reimplemented** — `ConstructIndex` wraps
  `aws-cdk-lib/assertions`' `Template` for the resolved JSON. Go through it.
- **Layers** (each narrows the previous):
  - `ConstructTree.fromStack(stack)` → entry point, builds the index
  - `ConstructQuery<T>` (`query.ts`) → `findByType` / `where` / `expectCount` / `one`
  - `ConstructSubject<T>` (`subject.ts`) → `satisfies` / `expectProperty` / `defaultResource` / `dependsOn` / `references`
  - `L1Subject<C, P>` (`l1-subject.ts`) → `toMatchProps` (typed against `CfnXxxProps`)
- **Wiring** (`src/wiring/`) → `expectGrant` / `expectConnection` / `expectEncryption`,
  each built on the index + intrinsic helpers (`src/private/intrinsics.ts`:
  `referencesAnyLogicalId` / `idMatches` / `actionMatches`).

## Layout

| Path           | Purpose                                                                |
| -------------- | ---------------------------------------------------------------------- |
| `src/`         | Library source (`index.ts` is the entry/barrel)                        |
| `src/private/` | Internal: index, intrinsics, shared types — not part of the public API |
| `src/wiring/`  | Intent-level relationship assertions                                   |
| `tests/`       | Behavioral tests (vitest)                                              |
| `tests/types/` | Type-level tests via `@ts-expect-error` (enforced by `vp check`)       |
| `docs/`        | Design doc + working notes — **gitignored**, keep rationale here       |

## Hard conventions (must follow)

- **ESM + `nodenext`:** every relative import MUST carry a `.ts` extension
  (`import { x } from "./query.ts"`). The build/typecheck fails otherwise.
- **`verbatimModuleSyntax`:** type-only imports MUST use `import type` (or the
  inline `type` modifier, e.g. `import { Match, type Matcher }`); type-only
  re-exports use `export type`.
- **Errors are path-centric:** throw a plain `Error` whose message includes the
  construct `node.path` (not just the logical id) so failures are reviewable.
- **`toMatchProps` matching:** the expected object is the camelCase `CfnXxxProps`
  authoring shape; matching reads each referenced prop **off the L1 instance and
  token-resolves it** (not the PascalCase template). Do not switch to
  template-based matching — it reintroduces a casing heuristic.

## Toolchain (`vp` / Vite+)

- `vp test` — vitest. Import test helpers from **`"vite-plus/test"`**, not `"vitest"`.
- `vp check` — format (oxfmt) + lint (oxlint, type-aware) + type check. Also
  enforces the type-level tests. **oxfmt uses double quotes**; run `vp check --fix`
  to auto-format.
- `vp pack` — build to `dist/` (`index.mjs` + `index.d.mts`).
- `pnpm gen:iam-actions` — regenerate `src/private/iam-actions.generated.ts` (the
  `ExactIamAction`/`IamService` unions) from the official AWS Service Reference.
  Commit the output; the build never hits the network. The file is **type-only**
  (erased from `index.mjs`, ~20k actions) and is excluded from oxfmt/oxlint via
  `ignorePatterns`, but tsc still type-checks it transitively. The public
  `IamAction` type (exact actions + known-service wildcards) lives in the
  hand-written `src/private/iam-action.ts`; never edit the generated file by hand.
- Peers: `aws-cdk-lib` (^2) and `constructs` (^10), present as devDeps for tests.

## Type-level tests — known gotcha

`tests/types/*.ts` assert that incorrect usage fails to compile via
`@ts-expect-error`. A directive only suppresses the error on the **immediately
following line**. oxfmt breaks long method chains across multiple lines, which
detaches the directive from the line that actually errors → "unused directive" +
an unsuppressed error. **Pattern:** extract the subject to a variable, then keep
the erroring call as a single short line directly after the directive.

## Adding a new wiring assertion (main extension path)

1. `export function expectX(tree): XAssertion` returning a fluent builder
   (`.subject(a).verb(b)` — reads as a sentence; jsii-incompat fluency is fine).
2. Resolve everything through `ConstructIndex` + the intrinsic helpers; do not
   walk raw templates ad hoc.
3. Provide a **negative** variant (`cannot` / `expectNo*`) — verifying absence
   (no public access, no `s3:*`, no plaintext secret) is a core value.
4. Add a behavioral test in `tests/` and keep the API intent-readable.

See `docs/tree-assertions-design.md` (gitignored) for the full design and the
prioritized roadmap of assertions to add.

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->
