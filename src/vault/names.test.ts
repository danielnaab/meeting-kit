import { expect, test } from "bun:test";
import { fileName, linkPath } from "./names.ts";

test("fileName: the nearest filename to a name, as notebook-kit's names.py makes it", () => {
  expect(fileName("Pat Lee")).toBe("Pat Lee");
  expect(fileName("Q3: plan?")).toBe("Q3 - plan");
  expect(fileName("A/B | C")).toBe("A - B - C");
  expect(fileName('Say "hi" [draft]')).toBe("Say 'hi' (draft)");
  expect(fileName("Words, etc.")).toBe("Words, etc.");
  expect(fileName(".env notes")).toBe("env notes");
  expect(fileName("Luigi  Ray-Montan\u0303ez")).toBe("Luigi Ray-Montañez");
  expect(new TextEncoder().encode(fileName("word ".repeat(100))).length).toBeLessThanOrEqual(200);
  expect(fileName(" ?? ")).toBe("");
});

test("linkPath: spaces, parentheses and non-ASCII percent-encoded, as notebook-kit writes links", () => {
  expect(linkPath("../../../wiki/people/Ada Lovelace.md")).toBe("../../../wiki/people/Ada%20Lovelace.md");
  expect(linkPath("people/Catherine (Cassie) Winters.md")).toBe("people/Catherine%20%28Cassie%29%20Winters.md");
  expect(linkPath("people/Luigi Ray-Montañez.md")).toBe("people/Luigi%20Ray-Monta%C3%B1ez.md");
  expect(linkPath("2026-11/2026-11-05-weekly-sync.md")).toBe("2026-11/2026-11-05-weekly-sync.md");
});
