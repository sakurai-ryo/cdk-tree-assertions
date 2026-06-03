import { expect, test } from "vite-plus/test";
import { ConstructTree } from "../src/index.ts";

test("library entry exports ConstructTree", () => {
  expect(typeof ConstructTree.fromStack).toBe("function");
});
