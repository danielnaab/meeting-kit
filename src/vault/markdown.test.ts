import { expect, test } from "bun:test";
import { spaceHeadings } from "./markdown.ts";

test("spaceHeadings", () => {
  expect(spaceHeadings("a\n### H\nb\n```\n# not\n```\n## Two\n")).toBe("a\n\n### H\n\nb\n```\n# not\n```\n\n## Two\n");
});
