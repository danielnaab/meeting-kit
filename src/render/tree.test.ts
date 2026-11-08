import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { drift, fill, readTree, renderTemplates, TemplateError, writeTree } from "./tree.ts";

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "tree-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const put = (path: string, text: string) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};

describe("fill", () => {
  const spec = { replace: [["f/kit/", "f/mine/"]] as [string, string][], values: { zone: "America/New_York", n: "3" } };

  test("replaces literal strings and placeholders, in one pass", () => {
    expect(fill('import "/f/kit/a.ts"; tz("{{zone}}") {{ n }}', spec, "x")).toBe('import "/f/mine/a.ts"; tz("America/New_York") 3');
  });
  test("a value that looks like a placeholder is not expanded again", () => {
    expect(fill("{{a}}", { values: { a: "{{b}}", b: "no" } }, "x")).toBe("{{b}}");
  });
  test("an unknown placeholder throws, naming the file and every one", () => {
    expect(() => fill("{{zone}} {{nope}} {{ also-not }}", spec, "dir/file.ts")).toThrow(TemplateError);
    expect(() => fill("{{zone}} {{nope}} {{ also-not }}", spec, "dir/file.ts")).toThrow(/dir\/file\.ts: unknown placeholder\(s\) nope, also-not/);
  });
  test("a stray {{ left after filling throws", () => {
    expect(() => fill("x {{ y", spec, "f")).toThrow(/leftover/);
  });
});

describe("renderTemplates", () => {
  test("renders every file under the template dir, renamed and filtered", () => {
    put("t/a.txt", "{{zone}}");
    put("t/sub/b.yaml", "path: f/kit/sub/b");
    put("t/sub/skip.txt", "{{nope}}");
    const files = renderTemplates(join(dir, "t"), { replace: [["f/kit/", "f/mine/"]], values: { zone: "UTC" } }, {
      include: (rel) => !rel.endsWith("skip.txt"),
      rename: (rel) => `f/mine/${rel}`,
    });
    expect([...files]).toEqual([["f/mine/a.txt", "UTC"], ["f/mine/sub/b.yaml", "path: f/mine/sub/b"]]);
  });
});

describe("writeTree and drift", () => {
  const files = new Map([["f/mine/a.txt", "A"], ["f/mine/sub/b.txt", "B"], ["README.md", "R"]]);
  const owned = ["f/mine/", "README.md"];

  test("writes the files, removes stale ones in owned dirs, and leaves the rest alone", () => {
    put("out/f/mine/old/gone.txt", "stale");
    put("out/f/other/keep.txt", "theirs");
    put("out/wmill-lock.yaml", "keep");
    const { written, removed } = writeTree(join(dir, "out"), owned, files);
    expect(written.sort()).toEqual(["README.md", "f/mine/a.txt", "f/mine/sub/b.txt"]);
    expect(removed).toEqual(["f/mine/old/gone.txt"]);
    expect(existsSync(join(dir, "out/f/mine/old"))).toBe(false);
    expect(readFileSync(join(dir, "out/f/other/keep.txt"), "utf8")).toBe("theirs");
    expect(readTree(join(dir, "out/f/mine"))).toEqual(new Map([["a.txt", "A"], ["sub/b.txt", "B"]]));
    expect(drift(join(dir, "out"), owned, files)).toEqual([]);
  });

  test("drift lists changed, missing and stale files", () => {
    writeTree(join(dir, "out"), owned, files);
    put("out/f/mine/a.txt", "edited by hand");
    rmSync(join(dir, "out/README.md"));
    put("out/f/mine/extra.txt", "x");
    expect(drift(join(dir, "out"), owned, files)).toEqual(["changed: f/mine/a.txt", "missing: README.md", "stale: f/mine/extra.txt"]);
  });

  test("an output dir that does not exist yet is all missing", () => {
    expect(drift(join(dir, "nowhere"), owned, files)).toEqual(["missing: README.md", "missing: f/mine/a.txt", "missing: f/mine/sub/b.txt"]);
  });
});
