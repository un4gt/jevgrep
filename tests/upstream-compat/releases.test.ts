import { expect, test } from "bun:test";
import { newer } from "../../scripts/upstream/versions";
test("release discovery never downgrades a newer pinned tag or uses a prerelease", () => {
  expect(newer("v0.8.0", "v0.8.5")).toBe(false);
  expect(newer("v0.8.5", "v0.8.5")).toBe(false);
  expect(newer("v0.8.10", "v0.8.5")).toBe(true);
  expect(newer("v1.0.0", "v0.8.5")).toBe(true);
  expect(() => newer("v1.0.0-rc.1", "v0.8.5")).toThrow();
});
