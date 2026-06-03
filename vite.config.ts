import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    dts: {
      tsgo: true,
    },
    exports: true,
  },
  lint: {
    // The generated action union is huge and machine-authored; tsc still
    // type-checks it transitively, but oxlint/oxfmt should leave it alone.
    ignorePatterns: ["src/private/iam-actions.generated.ts"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    ignorePatterns: ["src/private/iam-actions.generated.ts"],
  },
});
